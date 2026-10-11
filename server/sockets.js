'use strict';
const { viewFor } = require('./game/view');

const TICK_MS = 1000; // engine timers are enforced at least once a second,
// satisfying the "changes reach every player within 1s" requirement; any
// player-triggered action broadcasts immediately regardless of this timer.

function broadcastLobby(io, room) {
  const payload = {
    code: room.code,
    players: room.players.map((p) => ({ id: p.id, nick: p.nick, connected: p.connected })),
    canStart: room.canStart(),
    started: !!room.game,
  };
  for (const p of room.players) {
    if (p.socketId) io.to(p.socketId).emit('room:update', { ...payload, isHost: room.players[0] && room.players[0].id === p.id, you: p.id });
  }
}

function broadcastGame(io, room) {
  if (!room.game) return;
  for (const p of room.players) {
    if (p.socketId && p.connected) {
      io.to(p.socketId).emit('game:state', viewFor(p.id, room.game));
    }
  }
}

function broadcast(io, room) {
  if (room.game) broadcastGame(io, room);
  else broadcastLobby(io, room);
}

function attachSocketHandlers(io, roomManager) {
  const roomTimers = new Map(); // code -> interval handle

  function ensureRoomTicking(room) {
    if (roomTimers.has(room.code)) return;
    const handle = setInterval(() => {
      if (!room.game) return;
      const changed = room.tick();
      if (changed) broadcast(io, room);
      if (room.game && room.game.phase === 'GAME_OVER') {
        clearInterval(handle);
        roomTimers.delete(room.code);
      }
    }, TICK_MS);
    roomTimers.set(room.code, handle);
  }

  io.on('connection', (socket) => {
    socket.data.roomCode = null;
    socket.data.playerId = null;

    socket.on('room:create', ({ nick }, cb) => {
      nick = String(nick || '').slice(0, 24).trim() || 'Hráč';
      const room = roomManager.createRoom(nick);
      const player = room.addPlayer(nick);
      player.socketId = socket.id;
      socket.data.roomCode = room.code;
      socket.data.playerId = player.id;
      socket.join(room.code);
      cb && cb({ ok: true, code: room.code, playerId: player.id, token: player.token });
      broadcast(io, room);
    });

    socket.on('room:join', ({ code, nick }, cb) => {
      const room = roomManager.getRoom(code);
      if (!room) return cb && cb({ ok: false, error: 'ROOM_NOT_FOUND' });
      if (room.game) return cb && cb({ ok: false, error: 'GAME_ALREADY_STARTED' });
      if (room.players.length >= 6) return cb && cb({ ok: false, error: 'ROOM_FULL' });
      nick = String(nick || '').slice(0, 24).trim() || 'Hráč';
      const player = room.addPlayer(nick);
      player.socketId = socket.id;
      socket.data.roomCode = room.code;
      socket.data.playerId = player.id;
      socket.join(room.code);
      cb && cb({ ok: true, code: room.code, playerId: player.id, token: player.token });
      broadcast(io, room);
    });

    socket.on('room:reconnect', ({ code, token }, cb) => {
      const room = roomManager.getRoom(code);
      if (!room) return cb && cb({ ok: false, error: 'ROOM_NOT_FOUND' });
      const player = room.findByToken(token);
      if (!player) return cb && cb({ ok: false, error: 'INVALID_TOKEN' });
      player.connected = true;
      player.socketId = socket.id;
      socket.data.roomCode = room.code;
      socket.data.playerId = player.id;
      socket.join(room.code);
      cb && cb({ ok: true, code: room.code, playerId: player.id, token: player.token, started: !!room.game });
      broadcast(io, room);
    });

    socket.on('room:start', (_payload, cb) => {
      const room = roomManager.getRoom(socket.data.roomCode);
      if (!room) return cb && cb({ ok: false, error: 'ROOM_NOT_FOUND' });
      if (room.players[0] && room.players[0].id !== socket.data.playerId) {
        return cb && cb({ ok: false, error: 'ONLY_HOST_CAN_START' });
      }
      if (!room.canStart()) return cb && cb({ ok: false, error: 'NEED_3_TO_6_PLAYERS' });
      room.start();
      ensureRoomTicking(room);
      cb && cb({ ok: true });
      broadcast(io, room);
    });

    socket.on('game:action', (action, cb) => {
      const room = roomManager.getRoom(socket.data.roomCode);
      if (!room || !room.game) return cb && cb({ ok: false, error: 'NO_GAME' });
      const result = room.applyAction(socket.data.playerId, action);
      broadcast(io, room);
      cb && cb(result && result.error ? { ok: false, error: result.error } : { ok: true });
    });

    socket.on('disconnect', () => {
      const room = roomManager.getRoom(socket.data.roomCode);
      if (!room) return;
      const player = room.players.find((p) => p.id === socket.data.playerId);
      if (player) {
        player.connected = false;
        player.socketId = null;
        broadcast(io, room);
        roomManager.removeRoomIfEmpty(room.code);
      }
    });
  });
}

module.exports = { attachSocketHandlers };
