// =============================================================================
// server.js — WebSocket + HTTP Server
// =============================================================================
require('dotenv').config();

const express = require('express');
const http    = require('http');
const { Server } = require('socket.io');
const cors    = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);

const FRONTEND_ORIGIN = process.env.FRONTEND_URL || 'http://localhost:5173';

const io = new Server(server, {
  cors: {
    origin: FRONTEND_ORIGIN,
    methods: ['GET', 'POST'],
  },
  // Tune for high-frequency telemetry: reduce latency, allow compression
  pingTimeout:  10000,
  pingInterval:  5000,
  transports: ['websocket'], // skip polling for lower latency
});

// --- Connection tracking ---
let connectedClients = 0;

io.on('connection', (socket) => {
  connectedClients++;
  console.log(`🟢 Frontend connected [${socket.id}] — active clients: ${connectedClients}`);

  // Emit current connection count to all clients
  io.emit('system_status', { connectedClients });

  socket.on('disconnect', (reason) => {
    connectedClients--;
    console.log(`🔴 Frontend disconnected [${socket.id}] reason: ${reason} — active clients: ${connectedClients}`);
    io.emit('system_status', { connectedClients });
  });
});

// --- Health check endpoint ---
app.get('/health', (req, res) => {
  res.json({
    status:    'ok',
    uptime:    process.uptime(),
    clients:   connectedClients,
    timestamp: new Date().toISOString(),
  });
});

const WS_PORT = parseInt(process.env.WS_PORT, 10) || 3000;
server.listen(WS_PORT, () => {
  console.log(`🚀 WebSocket server on port ${WS_PORT} | Frontend: ${FRONTEND_ORIGIN}`);
});

module.exports = { io };
