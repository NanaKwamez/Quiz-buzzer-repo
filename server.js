const express = require("express");
const https = require("https");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { Server } = require("socket.io");
const QRCode = require("qrcode");

const app = express();
const certFile = process.env.SSL_CERT || path.join(__dirname, "certs", "localhost.pem");
const keyFile = process.env.SSL_KEY || path.join(__dirname, "certs", "localhost-key.pem");
let server;
if (fs.existsSync(certFile) && fs.existsSync(keyFile)) {
  server = https.createServer({ cert: fs.readFileSync(certFile), key: fs.readFileSync(keyFile) }, app);
} else {
  const http = require("http");
  server = http.createServer(app);
}
const io = new Server(server);
const PORT = Number(process.env.PORT) || 3000;

app.use(express.static(path.join(__dirname, "public")));
app.get("/", (req, res) => res.redirect("/host.html"));

const teams = new Map();
const socketsByTeam = new Map();
let pressQueue = [];
let falseStarts = new Map();
let gameState = "waiting";
let timer = null;
let config = { points: 10, wrongPoints: 0, timerSeconds: 10 };
const blockedTeams = new Set();
const blockedGroups = new Set();
let onlyActiveMic = true;
let pushToTalk = false;
let muteAll = false;
let liveTeam = null;

function getTeam(teamNumber) {
  if (!teams.has(teamNumber)) {
    teams.set(teamNumber, { number: teamNumber, name: "", group: "", score: 0, connected: false, micBlocked: false, live: false });
  }
  return teams.get(teamNumber);
}

function publicState() {
  return {
    teams: Array.from(teams.values()).sort((a, b) => a.number - b.number),
    queue: pressQueue.map((entry) => ({ ...entry, gap: entry.timestamp - (pressQueue[0]?.timestamp || entry.timestamp) })),
    falseStarts: Array.from(falseStarts.values()),
    gameState,
    config,
    voice: {
      blockedTeams: Array.from(blockedTeams),
      blockedGroups: Array.from(blockedGroups),
      onlyActiveMic,
      pushToTalk,
      muteAll,
      liveTeam
    }
  };
}

function broadcastState() {
  io.emit("state", publicState());
}

function clearTimer() {
  if (timer) clearTimeout(timer);
  timer = null;
}

function activeTeamNumber() {
  return pressQueue.length ? pressQueue[0].number : null;
}

function micAllowed(number, held = false) {
  const team = getTeam(number);
  if (muteAll || blockedTeams.has(number) || blockedGroups.has(team.group)) return false;
  if (onlyActiveMic && activeTeamNumber() !== number) return false;
  if (pushToTalk && !held) return false;
  return true;
}

function setMicLive(number, live) {
  liveTeam = live ? number : (liveTeam === number ? null : liveTeam);
  const team = teams.get(number);
  if (team) team.live = live;
  broadcastState();
}

function sendMicState(socket, number) {
  const team = teams.get(number);
  const blocked = !!team && (blockedTeams.has(number) || blockedGroups.has(team.group) || muteAll);
  socket.emit("mic_command", {
    enabled: micAllowed(number),
    blocked,
    liveTeam: activeTeamNumber(),
    pushToTalk,
    onlyActiveMic
  });
}

function syncAllMics() {
  blockedTeams.forEach((number) => {
    const teamSocket = io.sockets.sockets.get(socketsByTeam.get(number));
    if (teamSocket) sendMicState(teamSocket, number);
  });
  socketsByTeam.forEach((socketId, number) => {
    const teamSocket = io.sockets.sockets.get(socketId);
    if (teamSocket) sendMicState(teamSocket, number);
  });
  broadcastState();
}

function registerTeam(socket, number, name, group) {
  number = Number(number);
  if (!Number.isInteger(number) || number < 1 || number > 12) return;
  const team = getTeam(number);
  team.name = typeof name === "string" && name.trim() ? name.trim().slice(0, 30) : team.name;
  team.group = typeof group === "string" ? group.trim().slice(0, 30) : team.group;
  team.connected = true;
  socket.teamNumber = number;
  socketsByTeam.set(number, socket.id);
  socket.emit("registered", { teamNumber: number, name: team.name, group: team.group });
  sendMicState(socket, number);
  broadcastState();
}

io.on("connection", (socket) => {
  socket.on("register", ({ number, name, group }) => registerTeam(socket, number, name, group));

  socket.on("host_join", () => {
    socket.isHost = true;
  });

  // Signaling is relayed only; ICE candidates are restricted to hostCandidates by
  // the clients, so no STUN/TURN server is used.
  socket.on("phone_offer", ({ sdp }) => {
    if (!socket.teamNumber || !sdp) return;
    io.emit("phone_offer", { number: socket.teamNumber, sdp });
  });

  socket.on("phone_ice", ({ candidate }) => {
    if (!socket.teamNumber || !candidate) return;
    io.emit("phone_ice", { number: socket.teamNumber, candidate });
  });

  socket.on("host_answer", ({ number, sdp }) => {
    if (!socket.isHost) return;
    number = Number(number);
    const target = io.sockets.sockets.get(socketsByTeam.get(number));
    if (target) target.emit("host_answer", { sdp });
  });

  socket.on("host_ice", ({ number, candidate }) => {
    if (!socket.isHost) return;
    number = Number(number);
    const target = io.sockets.sockets.get(socketsByTeam.get(number));
    if (target) target.emit("host_ice", { candidate });
  });

  socket.on("ptt", ({ held }) => {
    if (!socket.teamNumber) return;
    const number = socket.teamNumber;
    if (pushToTalk && micAllowed(number, !!held)) {
      setMicLive(number, !!held);
      socket.emit("mic_command", { enabled: !!held, blocked: false, liveTeam: number, pushToTalk, onlyActiveMic });
    } else {
      sendMicState(socket, number);
    }
  });

  socket.on("voice_live", ({ live }) => {
    if (!socket.teamNumber) return;
    if (live && micAllowed(socket.teamNumber, true)) setMicLive(socket.teamNumber, true);
    else setMicLive(socket.teamNumber, false);
  });

  socket.on("buzz", () => {
    const number = socket.teamNumber;
    if (!number) return;
    const team = getTeam(number);

    if (gameState !== "open") {
      // Waiting and locked rounds both receive a false-start mark if buzzing early.
      if (!falseStarts.has(number) && gameState !== "locked") {
        falseStarts.set(number, number);
      } else if (gameState === "locked") {
        return;
      }
      broadcastState();
      return;
    }

    if (falseStarts.has(number) || pressQueue.some((entry) => entry.number === number)) return;
    pressQueue.push({ number, name: team.name, timestamp: Date.now() });
    broadcastState();
    syncAllMics();
  });

  socket.on("host_open", () => {
    clearTimer();
    pressQueue = [];
    gameState = "open";
    liveTeam = null;
    broadcastState();
    syncAllMics();
    if (config.timerSeconds > 0) {
      timer = setTimeout(() => {
        if (gameState === "open") {
          io.emit("time_up");
          gameState = "locked";
          broadcastState();
        }
      }, config.timerSeconds * 1000);
    }
  });

  socket.on("host_correct", () => {
    if (pressQueue.length) {
      const active = pressQueue[0];
      const team = getTeam(active.number);
      team.score += Number(config.points) || 0;
    }
    clearTimer();
    gameState = "locked";
    liveTeam = null;
    broadcastState();
    syncAllMics();
  });

  socket.on("host_wrong", () => {
    if (!pressQueue.length) return;
    const removed = pressQueue.shift();
    const team = getTeam(removed.number);
    team.score -= Number(config.wrongPoints) || 0;
    if (pressQueue.length) {
      io.emit("wrong", { promoted: pressQueue[0].number });
    } else {
      io.emit("wrong", { promoted: null });
    }
    liveTeam = null;
    broadcastState();
    syncAllMics();
  });

  socket.on("host_reset", () => {
    clearTimer();
    pressQueue = [];
    falseStarts = new Map();
    gameState = "waiting";
    liveTeam = null;
    broadcastState();
    syncAllMics();
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
    if (socketsByTeam.get(number)) {
      const target = io.sockets.sockets.get(socketsByTeam.get(number));
      if (target) target.emit("kicked");
      socketsByTeam.delete(number);
    }
    blockedTeams.delete(number);
    broadcastState();
    syncAllMics();
  });

  socket.on("host_config", (incoming) => {
    config = {
      points: Math.max(0, Number(incoming.points) || 0),
      wrongPoints: Math.max(0, Number(incoming.wrongPoints) || 0),
      timerSeconds: Math.max(0, Number(incoming.timerSeconds) || 0)
    };
    broadcastState();
  });

  socket.on("host_block_team", ({ number, blocked }) => {
    number = Number(number);
    if (blocked) blockedTeams.add(number);
    else blockedTeams.delete(number);
    const team = teams.get(number);
    if (team) team.micBlocked = blocked;
    syncAllMics();
  });

  socket.on("host_block_group", ({ group, blocked }) => {
    group = String(group || "").trim();
    if (!group) return;
    if (blocked) blockedGroups.add(group);
    else blockedGroups.delete(group);
    syncAllMics();
  });

  socket.on("host_voice_config", (incoming) => {
    if (typeof incoming.onlyActiveMic === "boolean") onlyActiveMic = incoming.onlyActiveMic;
    if (typeof incoming.pushToTalk === "boolean") pushToTalk = incoming.pushToTalk;
    if (typeof incoming.muteAll === "boolean") muteAll = incoming.muteAll;
    syncAllMics();
  });

  socket.on("host_mute_all", () => {
    muteAll = true;
    syncAllMics();
  });

  socket.on("host_unblock_all", () => {
    blockedTeams.clear();
    blockedGroups.clear();
    muteAll = false;
    teams.forEach((team) => { team.micBlocked = false; });
    syncAllMics();
  });

  socket.on("disconnect", () => {
    if (socket.teamNumber) {
      const team = getTeam(socket.teamNumber);
      team.connected = false;
      if (liveTeam === socket.teamNumber) liveTeam = null;
      if (socketsByTeam.get(socket.teamNumber) === socket.id) socketsByTeam.delete(socket.teamNumber);
      broadcastState();
    }
  });

  socket.emit("state", publicState());
});

function localIP() {
  const interfaces = os.networkInterfaces();
  for (const entries of Object.values(interfaces)) {
    for (const entry of entries || []) {
      if (entry.family === "IPv4" && !entry.internal) return entry.address;
    }
  }
  return "127.0.0.1";
}

server.listen(PORT, "0.0.0.0", async () => {
  const ip = localIP();
  const secured = server instanceof https.Server;
  const protocol = secured ? "https" : "http";
  if (!secured) {
    console.warn("WARNING: HTTPS certificates not found. Microphone access will not work on phones.");
    console.warn(`Create certs/localhost.pem and certs/localhost-key.pem, or set SSL_CERT and SSL_KEY.`);
  }
  const hostUrl = `${protocol}://${ip}:${PORT}`;
  const buzzerUrl = `${hostUrl}/buzzer.html`;
  try {
    app.locals.buzzerQR = await QRCode.toDataURL(buzzerUrl);
  } catch (_) {
    app.locals.buzzerQR = "";
  }
  app.get("/qr", (_req, res) => res.json({ url: buzzerUrl, qr: app.locals.buzzerQR }));
  console.log(`\nQuiz Buzzer running at ${hostUrl}`);
  console.log(`Phone buzzer: ${buzzerUrl}\n`);
});
