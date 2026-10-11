'use strict';
const { nanoid } = require('nanoid');
const { Rng, makeSeed } = require('../game/rng');
const engine = require('../game/engine');
const config = require('../config.json');

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I ambiguity

function randomCode(len = 5) {
  let s = '';
  for (let i = 0; i < len; i++) s += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
  return s;
}

class Room {
  constructor(code, hostNick) {
    this.code = code;
    this.id = code;
    this.seed = makeSeed();
    this.rng = new Rng(this.seed);
    this.players = []; // {id, nick, token, connected, socketId}
    this.game = null; // created on start
    this.createdAt = Date.now();
    this.tickInterval = null;
  }

  addPlayer(nick) {
    const id = nanoid(10);
    const token = nanoid(24);
    const player = { id, nick, token, connected: true, socketId: null };
    this.players.push(player);
    return player;
  }

  findByToken(token) {
    return this.players.find((p) => p.token === token);
  }

  canStart() {
    return this.players.length >= 3 && this.players.length <= 6;
  }

  start() {
    // IMPORTANT: game.players shares the exact same player objects as
    // this.players (not copies), so connect/disconnect updates made on
    // socket events are automatically visible inside the engine's state
    // without any extra sync step.
    this.game = engine.newGame(this.code, config, this.seed, this.players);
    engine.startGame(this.game, this.rng);
  }

  applyAction(playerId, action) {
    if (!this.game) return { error: 'GAME_NOT_STARTED' };
    return engine.applyAction(this.game, playerId, action, this.rng);
  }

  tick() {
    if (!this.game) return false;
    return engine.tick(this.game, this.rng);
  }
}

class RoomManager {
  constructor() {
    this.rooms = new Map();
  }

  createRoom(hostNick) {
    let code;
    do {
      code = randomCode();
    } while (this.rooms.has(code));
    const room = new Room(code, hostNick);
    this.rooms.set(code, room);
    return room;
  }

  getRoom(code) {
    return this.rooms.get((code || '').toUpperCase());
  }

  removeRoomIfEmpty(code) {
    const room = this.rooms.get(code);
    if (room && room.players.every((p) => !p.connected)) {
      // Keep finished/abandoned rooms around for a while for reconnection
      // debugging, but stop their timers.
      if (room.tickInterval) clearInterval(room.tickInterval);
    }
  }
}

module.exports = { RoomManager, Room };
