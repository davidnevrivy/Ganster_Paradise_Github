'use strict';
const { io } = require('socket.io-client');
const URL = process.argv[2] || 'http://localhost:3000';
const N = 3;

function connect() {
  return new Promise((resolve) => {
    const s = io(URL, { transports: ['websocket'] });
    s.on('connect', () => resolve(s));
  });
}
function emit(socket, event, payload) {
  return new Promise((resolve) => socket.emit(event, payload, resolve));
}
function wait(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function main() {
  const sockets = await Promise.all(Array.from({ length: N }, connect));
  const states = new Array(N);
  sockets.forEach((s, i) => s.on('game:state', (v) => { states[i] = v; }));

  const createAck = await emit(sockets[0], 'room:create', { nick: 'Host' });
  const code = createAck.code;
  const acks = [createAck];
  for (let i = 1; i < N; i++) acks.push(await emit(sockets[i], 'room:join', { code, nick: `P${i}` }));
  await wait(150);
  await emit(sockets[0], 'room:start', {});
  await wait(300);

  console.log('Phase after start:', states[0].phase);

  // Everyone clicks ready to skip negotiation.
  for (let i = 0; i < N; i++) await emit(sockets[i], 'game:action', { type: 'negotiation_ready' });
  await wait(300);
  console.log('Phase after all ready:', states[0].phase, 'activePlayer:', states[0].activePlayer);

  const activeIdx = acks.findIndex((a) => a.playerId === states[0].activePlayer);
  if (activeIdx < 0) throw new Error('could not find active player among sockets');
  const beforeHandLen = states[activeIdx].players.find((p) => p.id === acks[activeIdx].playerId).hand.length;
  const drawAck = await emit(sockets[activeIdx], 'game:action', { type: 'turn_action', subtype: 'draw_card', payload: {} });
  if (!drawAck.ok) throw new Error('draw_card failed: ' + drawAck.error);
  await wait(200);
  const afterHandLen = states[activeIdx].players.find((p) => p.id === acks[activeIdx].playerId).hand.length;
  console.log('Hand length before/after draw_card:', beforeHandLen, afterHandLen, 'actionsLeft:', states[activeIdx].actionsLeft);
  if (afterHandLen !== beforeHandLen + 1) throw new Error(`draw_card should add exactly 1 card (${beforeHandLen} -> ${afterHandLen})`);

  // Reconnection: disconnect player 1 (non-active, to keep active player simple), reconnect with stored token.
  const victimIdx = (activeIdx + 1) % N;
  const token = acks[victimIdx].token;
  sockets[victimIdx].disconnect();
  await wait(300);
  console.log('After disconnect, connected flag for that player (as seen by host):', states[0].players[victimIdx].connected);

  const freshSocket = await connect();
  const reconnectAck = await emit(freshSocket, 'room:reconnect', { code, token });
  if (!reconnectAck.ok) throw new Error('reconnect failed: ' + reconnectAck.error);
  await wait(300);
  let myView = null;
  freshSocket.on('game:state', (v) => { myView = v; });
  await wait(300);
  console.log('Reconnected ok, started flag:', reconnectAck.started);

  console.log('ALL GOOD');
  process.exit(0);
}

main().catch((e) => { console.error('FAIL', e); process.exit(1); });
