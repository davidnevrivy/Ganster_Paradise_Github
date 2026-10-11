'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Rng } = require('../server/game/rng');
const engine = require('../server/game/engine');
const config = require('../server/config.json');

function buildGame(n, seed) {
  const rng = new Rng(seed);
  const players = Array.from({ length: n }, (_, i) => ({ id: `p${i}`, nick: `N${i}`, token: `t${i}`, connected: true }));
  const game = engine.newGame('TEST', config, seed, players);
  engine.startGame(game, rng);
  return game;
}

test('same seed produces identical setup (character pool, estates, hands, investigation)', () => {
  const a = buildGame(5, 12345);
  const b = buildGame(5, 12345);
  assert.deepEqual(a.players.map((p) => p.character), b.players.map((p) => p.character));
  assert.deepEqual(a.setAside, b.setAside);
  assert.deepEqual(a.estates.map((e) => ({ owner: e.owner, grow: e.grow })), b.estates.map((e) => ({ owner: e.owner, grow: e.grow })));
  assert.deepEqual(a.players.map((p) => p.hand), b.players.map((p) => p.hand));
  assert.equal(a.investigation, b.investigation);
});

test('different seeds usually diverge', () => {
  const a = buildGame(5, 1);
  const b = buildGame(5, 2);
  const same = JSON.stringify(a.players.map((p) => p.character)) === JSON.stringify(b.players.map((p) => p.character));
  assert.equal(same, false);
});

test('replaying the same sequence of actions on the same seed reaches the same state', () => {
  const seed = 999;
  const g1 = buildGame(3, seed);
  const g2 = buildGame(3, seed);
  const rng1 = new Rng(seed); // fresh rng won't match internal state exactly but actions below don't rely on further rng draws besides deterministic deck pops
  const action = { type: 'turn_action', subtype: 'draw_card', payload: {} };
  const r1 = engine.applyAction(g1, g1.activePlayer, action, new Rng(seed + 1));
  const r2 = engine.applyAction(g2, g2.activePlayer, action, new Rng(seed + 1));
  assert.deepEqual(r1, r2);
  assert.deepEqual(g1.players.map((p) => p.hand), g2.players.map((p) => p.hand));
});
