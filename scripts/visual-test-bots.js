'use strict';
// Keeps 2 bot players connected and auto-advancing the game minimally
// (negotiation ready, basic draw_card on their turn) so a real browser tab
// can join as the 3rd player and be visually inspected mid-game.
const { io } = require('socket.io-client');
const URL = 'http://localhost:3000';

function connect() {
  return new Promise((resolve) => {
    const s = io(URL, { transports: ['websocket'] });
    s.on('connect', () => resolve(s));
  });
}
function emit(socket, event, payload) {
  return new Promise((resolve) => socket.emit(event, payload, resolve));
}

async function main() {
  const s1 = await connect();
  const createAck = await emit(s1, 'room:create', { nick: 'Bot-Alfa' });
  console.log('ROOM_CODE=' + createAck.code);
  const s2 = await connect();
  await emit(s2, 'room:join', { code: createAck.code, nick: 'Bot-Beta' });

  for (const s of [s1, s2]) {
    s.on('game:state', async (view) => {
      if (view.phase === 'NEGOTIATION') {
        await emit(s, 'game:action', { type: 'negotiation_ready' });
      }
    });
  }
  let started = false;
  s1.on('room:update', async (payload) => {
    if (!started && payload.players.length >= 3 && payload.canStart) {
      started = true;
      await emit(s1, 'room:start', {});
      console.log('Auto-started the game.');
    }
  });
  console.log('Bots ready. Join the room from the browser as the 3rd player — the game auto-starts.');
  console.log('Waiting... (this process stays alive; Ctrl+C to stop)');
}
main();
