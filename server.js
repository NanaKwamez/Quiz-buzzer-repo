const express = require("express");
const http = require("http");
const os = require("os");
const path = require("path");
const { Server } = require("socket.io");
const QRCode = require("qrcode");

const app = express();
const server = http.createServer(app);
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

function getTeam(teamNumber) {
  if (!teams.has(teamNumber)) {
    teams.set(teamNumber, { number: teamNumber, name: "", score: 0, connected: false });
  }
  return teams.get(teamNumber);
}

function publicState() {
  return {
    teams: Array.from(teams.values()).sort((a, b) => a.number - b.number),
    queue: pressQueue.map((entry) => ({ ...entry, gap: entry.timestamp - (pressQueue[0]?.timestamp || entry.timestamp) })),
    falseStarts: Array.from(falseStarts.values()),
    gameState,
    config
  };
}

function broadcastState() {
  io.emit("state", publicState());
}

function clearTimer() {
  if (timer) clearTimeout(timer);
  timer = null;
}

function registerTeam(socket, number, name) {
  number = Number(number);
  if (!Number.isInteger(number) || number < 1 || number > 12) return;
  const team = getTeam(number);
  team.name = typeof name === "string" && name.trim() ? name.trim().slice(0, 30) : team.name;
  team.connected = true;
  socket.teamNumber = number;
  socketsByTeam.set(number, socket.id);
  socket.emit("registered", { teamNumber: number, name: team.name });
  broadcastState();
}

io.on("connection", (socket) => {
  socket.on("register", ({ number, name }) => registerTeam(socket, number, name));

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
  });

  socket.on("host_open", () => {
    clearTimer();
    pressQueue = [];
    gameState = "open";
    broadcastState();
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
    broadcastState();
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
    broadcastState();
  });

  socket.on("host_reset", () => {
    clearTimer();
    pressQueue = [];
    falseStarts = new Map();
    gameState = "waiting";
    broadcastState();
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
    broadcastState();
  });

  socket.on("host_config", (incoming) => {
    config = {
      points: Math.max(0, Number(incoming.points) || 0),
      wrongPoints: Math.max(0, Number(incoming.wrongPoints) || 0),
      timerSeconds: Math.max(0, Number(incoming.timerSeconds) || 0)
    };
    broadcastState();
  });

  socket.on("disconnect", () => {
    if (socket.teamNumber) {
      const team = getTeam(socket.teamNumber);
      team.connected = false;
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
  const hostUrl = `http://${ip}:${PORT}`;
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
