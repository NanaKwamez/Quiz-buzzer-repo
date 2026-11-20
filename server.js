const express = require("express");
const https = require("https");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { Server } = require("socket.io");
const QRCode = require("qrcode");
const selfsigned = require("selfsigned");

const app = express();
const PORT = Number(process.env.PORT) || 3000;
const certFile = process.env.SSL_CERT || path.join(__dirname, "certs", "localhost.pem");
const keyFile = process.env.SSL_KEY || path.join(__dirname, "certs", "localhost-key.pem");

app.use((_req, res, next) => {
  res.set("Cache-Control", "no-store");
  next();
});
app.use(express.static(path.join(__dirname, "public")));
app.get("/", (_req, res) => res.redirect("/host.html"));

const teams = new Map();
const socketsByTeam = new Map();
let pressQueue = [];
let falseStarts = new Map();
let gameState = "waiting";
let timer = null;
let config = { points: 10, wrongPoints: 0, timerSeconds: 10 };
let groupNames = ["Form 1", "Form 2", "Form 3"];
const blockedTeams = new Set();
const blockedGroups = new Set();
let onlyActiveMic = true;
let pushToTalk = false;
let muteAll = false;
let liveTeam = null;
let testMicTeam = null;
let testMicTimer = null;
let lastPublicState = "";

function localIP() {
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries || []) {
      if (entry.family === "IPv4" && !entry.internal) return entry.address;
    }
  }
  return "127.0.0.1";
}

async function loadCertificate(ip) {
  fs.mkdirSync(path.dirname(certFile), { recursive: true });
  fs.mkdirSync(path.dirname(keyFile), { recursive: true });
  const metaFile = path.join(path.dirname(certFile), "ip.txt");
  if (fs.existsSync(certFile) && fs.existsSync(keyFile)) {
    const cert = fs.readFileSync(certFile, "utf8");
    const key = fs.readFileSync(keyFile, "utf8");
    if (!fs.existsSync(metaFile) || fs.readFileSync(metaFile, "utf8").trim() === ip) {
      if (!fs.existsSync(metaFile)) fs.writeFileSync(metaFile, ip);
      return { cert, key };
    }
  }
  const pems = await selfsigned.generate([{ name: "commonName", value: ip }], {
    days: 3650,
    keySize: 2048,
    extensions: [{
      name: "subjectAltName",
      altNames: [
        { type: 2, value: "localhost" },
        { type: 7, ip }
      ]
    }]
  });
  fs.writeFileSync(certFile, pems.cert);
  fs.writeFileSync(keyFile, pems.private);
  fs.writeFileSync(path.join(path.dirname(certFile), "ip.txt"), ip);
  console.log(`Generated self-signed HTTPS certificate for ${ip}`);
  return { cert: pems.cert, key: pems.private };
}

function getTeam(number) {
  if (!teams.has(number)) teams.set(number, { number, name: "", group: "", score: 0, connected: false, micPermission: "unavailable" });
  return teams.get(number);
}

function activeTeamNumber() {
  return pressQueue.length ? pressQueue[0].number : testMicTeam;
}

function micAllowed(number, held = false) {
  const team = getTeam(number);
  if (muteAll || blockedTeams.has(number) || blockedGroups.has(team.group)) return false;
  if (testMicTeam === number) return true;
  if (onlyActiveMic && activeTeamNumber() !== number) return false;
  if (pushToTalk && !held) return false;
  return true;
}

function publicState() {
  return {
    teams: [...teams.values()].sort((a, b) => a.number - b.number),
    queue: pressQueue.map((entry) => ({ ...entry, gap: entry.timestamp - pressQueue[0].timestamp })),
    falseStarts: [...falseStarts.keys()],
    gameState,
    config,
    groupNames,
    voice: {
      blockedTeams: [...blockedTeams],
      blockedGroups: [...blockedGroups],
      onlyActiveMic,
      pushToTalk,
      muteAll,
      liveTeam,
      testMicTeam
    }
  };
}

function broadcastState() {
  const next = JSON.stringify(publicState());
  if (next === lastPublicState) return;
  lastPublicState = next;
  io.emit("state", JSON.parse(next));
}

function syncMics() {
  socketsByTeam.forEach((socketId, number) => {
    const target = io.sockets.sockets.get(socketId);
    if (!target) return;
    const team = getTeam(number);
    const blocked = blockedTeams.has(number) || blockedGroups.has(team.group) || muteAll;
    target.emit("mic_command", {
      enabled: micAllowed(number),
      blocked,
      pushToTalk,
      liveTeam: activeTeamNumber()
    });
  });
  broadcastState();
}

async function main() {
  const ip = localIP();
  const tls = await loadCertificate(ip);
  const server = https.createServer({ cert: tls.cert, key: tls.key }, app);
  global.io = io = new Server(server);

  io.on("connection", (socket) => {
    socket.on("register", ({ number, name, group }) => {
      number = Number(number);
      if (!Number.isInteger(number) || number < 1 || number > 12) return;
      const team = getTeam(number);
      team.name = String(name || "").trim().slice(0, 30);
      team.group = String(group || "").trim().slice(0, 30);
      team.connected = true;
      socket.teamNumber = number;
      socketsByTeam.set(number, socket.id);
      socket.emit("registered", { teamNumber: number, name: team.name, group: team.group });
      syncMics();
    });

    socket.on("mic_permission", ({ state }) => {
      if (!socket.teamNumber) return;
      if (["granted", "denied", "unavailable"].includes(state)) getTeam(socket.teamNumber).micPermission = state;
      broadcastState();
    });

    socket.on("host_join", () => { socket.isHost = true; });

    socket.on("phone_offer", ({ sdp }) => {
      if (socket.teamNumber && sdp) io.emit("phone_offer", { number: socket.teamNumber, sdp });
    });
    socket.on("phone_ice", ({ candidate }) => {
      if (socket.teamNumber && candidate) io.emit("phone_ice", { number: socket.teamNumber, candidate });
    });
    socket.on("host_answer", ({ number, sdp }) => {
      if (!socket.isHost) return;
      const target = io.sockets.sockets.get(socketsByTeam.get(Number(number)));
      if (target) target.emit("host_answer", { sdp });
    });
    socket.on("host_ice", ({ number, candidate }) => {
      if (!socket.isHost) return;
      const target = io.sockets.sockets.get(socketsByTeam.get(Number(number)));
      if (target) target.emit("host_ice", { candidate });
    });
    socket.on("host_ice_restart", ({ number }) => {
      if (!socket.isHost) return;
      const target = io.sockets.sockets.get(socketsByTeam.get(Number(number)));
      if (target) target.emit("host_ice_restart");
    });

    socket.on("buzz", () => {
      const number = socket.teamNumber;
      if (!number) return;
      if (gameState !== "open") {
        if (gameState !== "locked" && !falseStarts.has(number)) falseStarts.set(number, true);
        broadcastState();
        return;
      }
      if (falseStarts.has(number) || pressQueue.some((entry) => entry.number === number)) return;
      pressQueue.push({ number, name: getTeam(number).name, timestamp: Date.now() });
      broadcastState();
      syncMics();
    });

    socket.on("host_open", () => {
      clearTimeout(timer);
      pressQueue = [];
      falseStarts = new Map();
      gameState = "open";
      liveTeam = null;
      broadcastState();
      syncMics();
      if (config.timerSeconds > 0) {
        timer = setTimeout(() => {
          if (gameState === "open") {
            gameState = "locked";
            liveTeam = null;
            io.emit("time_up");
            broadcastState();
            syncMics();
          }
        }, config.timerSeconds * 1000);
      }
    });

    socket.on("host_correct", () => {
      if (pressQueue.length) getTeam(pressQueue[0].number).score += Number(config.points) || 0;
      clearTimeout(timer);
      gameState = "locked";
      liveTeam = null;
      broadcastState();
      syncMics();
    });

    socket.on("host_wrong", () => {
      if (!pressQueue.length) return;
      pressQueue.shift();
      const team = pressQueue[0];
      liveTeam = null;
      io.emit("wrong", { promoted: team ? team.number : null });
      broadcastState();
      syncMics();
    });

    socket.on("host_reset", () => {
      clearTimeout(timer);
      pressQueue = [];
      falseStarts = new Map();
      gameState = "waiting";
      liveTeam = null;
      broadcastState();
      syncMics();
    });

    socket.on("host_reset_scores", () => {
      teams.forEach((team) => { team.score = 0; });
      broadcastState();
    });

    socket.on("host_kick", (number) => {
      number = Number(number);
      teams.delete(number);
      pressQueue = pressQueue.filter((entry) => entry.number !== number);
      falseStarts.delete(number);
      blockedTeams.delete(number);
      if (socketsByTeam.has(number)) {
        io.sockets.sockets.get(socketsByTeam.get(number))?.emit("kicked");
        socketsByTeam.delete(number);
      }
      broadcastState();
      syncMics();
    });

    socket.on("host_config", (incoming) => {
      config.points = Math.max(0, Number(incoming.points) || 0);
      config.wrongPoints = Math.max(0, Number(incoming.wrongPoints) || 0);
      config.timerSeconds = Math.max(0, Number(incoming.timerSeconds) || 0);
      if (Array.isArray(incoming.groupNames)) {
        groupNames = incoming.groupNames.map((group) => String(group).trim()).filter(Boolean).slice(0, 20);
        if (!groupNames.length) groupNames = ["Form 1", "Form 2", "Form 3"];
      }
      broadcastState();
    });

    socket.on("host_voice_config", (incoming) => {
      if (typeof incoming.onlyActiveMic === "boolean") onlyActiveMic = incoming.onlyActiveMic;
      if (typeof incoming.pushToTalk === "boolean") pushToTalk = incoming.pushToTalk;
      syncMics();
    });
    socket.on("host_block_team", ({ number, blocked }) => {
      number = Number(number);
      if (blocked) blockedTeams.add(number); else blockedTeams.delete(number);
      syncMics();
    });
    socket.on("host_block_group", ({ group, blocked }) => {
      group = String(group || "").trim();
      if (blocked) blockedGroups.add(group); else blockedGroups.delete(group);
      syncMics();
    });
    socket.on("host_mute_all", () => { muteAll = true; syncMics(); });
    socket.on("host_unblock_all", () => { muteAll = false; blockedTeams.clear(); blockedGroups.clear(); syncMics(); });

    socket.on("host_test_mic", ({ number }) => {
      if (!socket.isHost) return;
      number = Number(number);
      clearTimeout(testMicTimer);
      testMicTeam = number;
      liveTeam = number;
      syncMics();
      testMicTimer = setTimeout(() => {
        testMicTeam = null;
        liveTeam = null;
        syncMics();
      }, 5000);
    });

    socket.on("ptt", ({ held }) => {
      const number = socket.teamNumber;
      if (!number) return;
      if (pushToTalk && micAllowed(number, !!held)) liveTeam = number;
      else if (liveTeam === number) liveTeam = null;
      syncMics();
    });
    socket.on("voice_live", ({ live }) => {
      const number = socket.teamNumber;
      if (!number) return;
      if (live && micAllowed(number, true)) liveTeam = number; else if (liveTeam === number) liveTeam = null;
      syncMics();
    });

    socket.on("disconnect", () => {
      if (socket.teamNumber) {
        getTeam(socket.teamNumber).connected = false;
        if (liveTeam === socket.teamNumber) liveTeam = null;
        if (socketsByTeam.get(socket.teamNumber) === socket.id) socketsByTeam.delete(socket.teamNumber);
        io.emit("phone_disconnected", { number: socket.teamNumber });
        broadcastState();
      }
    });

    socket.emit("state", publicState());
  });

  server.listen(PORT, "0.0.0.0", async () => {
    const hostUrl = `https://${localIP()}:${PORT}`;
    const buzzerUrl = `${hostUrl}/buzzer.html`;
    app.locals.buzzerQR = await QRCode.toDataURL(buzzerUrl);
    app.get("/qr", (_req, res) => res.json({ url: buzzerUrl, qr: app.locals.buzzerQR }));
    console.log(`\nQuiz Buzzer HTTPS running at ${hostUrl}`);
    console.log(`Phone buzzer: ${buzzerUrl}`);
  });
}

let io;
main().catch((error) => {
  console.error("Failed to start HTTPS server:", error);
  process.exit(1);
});
