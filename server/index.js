'use strict';
const path = require('path');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');
const { RoomManager } = require('./rooms/RoomManager');
const { attachSocketHandlers } = require('./sockets');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  // Same-origin only: the client is served from this same process, so no
  // wildcard CORS is needed — satisfies the "never use * in production"
  // baseline while staying simple for local/LAN play.
  cors: { origin: false },
});

const publicDir = path.join(__dirname, '..', 'public');
app.use(express.static(publicDir));

const roomManager = new RoomManager();
attachSocketHandlers(io, roomManager);

app.get('/healthz', (_req, res) => res.json({ ok: true }));

const PORT = process.env.PORT ? Number(process.env.PORT) : 3000;
const HOST = process.env.HOST || '0.0.0.0';

server.listen(PORT, HOST, () => {
  console.log(`Gangster Paradise běží na http://localhost:${PORT}`);
  console.log('Pro hraní v síti (mobil, ostatní zařízení) použij IP adresu tohoto počítače.');
});
