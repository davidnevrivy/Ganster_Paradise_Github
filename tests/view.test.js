'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Rng } = require('../server/game/rng');
const engine = require('../server/game/engine');
const { setupGame } = require('../server/game/setup');
const { viewFor } = require('../server/game/view');
const config = require('../server/config.json');

function freshGame(n = 4, seed = 42) {
  const rng = new Rng(seed);
  const players = Array.from({ length: n }, (_, i) => ({ id: `p${i}`, nick: `Hráč ${i}`, token: `t${i}`, connected: true, socketId: `s${i}` }));
  const game = engine.newGame('TEST', config, seed, players);
  engine.startGame(game, rng);
  return { game, rng };
}

test('viewFor never leaks another player\'s character, side, money or hand', () => {
  const { game } = freshGame(4);
  for (const viewer of game.players) {
    const view = viewFor(viewer.id, game);
    for (const p of view.players) {
      if (p.id !== viewer.id) {
        assert.equal(p.character, undefined, 'character of another player must not be visible');
        assert.equal(p.side, undefined, 'side of another player must not be visible');
        assert.equal(p.money, undefined, 'money of another player must not be visible');
        assert.equal(p.hand, undefined, 'hand of another player must not be visible');
      } else {
        assert.ok(p.character, 'own character must be visible to self');
        assert.equal(typeof p.money, 'number');
        assert.ok(Array.isArray(p.hand));
      }
    }
  }
});

test('viewFor never leaks setAside characters or the seed before GAME_OVER', () => {
  const { game } = freshGame(4);
  const view = viewFor(game.players[0].id, game);
  assert.equal(view.setAside, undefined);
  assert.equal(view.seed, undefined);
});

test('viewFor reveals everything once the game is over', () => {
  const { game } = freshGame(3);
  game.phase = 'GAME_OVER';
  game.winner = { playerId: game.players[0].id, side: game.players[0].side };
  const view = viewFor(game.players[1].id, game);
  assert.notEqual(view.setAside, undefined);
  for (const p of view.players) {
    assert.ok(p.character);
    assert.equal(typeof p.money, 'number');
  }
});

test('viewFor hides grow tokens the viewer has no knowledge of, and always shows the viewer\'s own', () => {
  // Use setupGame directly (skip beginRound) so no round-1 event (e.g.
  // Bulvár) has had a chance to legitimately reveal anything yet — we
  // want to test the baseline hidden-information state right after deal.
  const rng = new Rng(42);
  const players = Array.from({ length: 5 }, (_, i) => ({ id: `p${i}`, nick: `H${i}`, token: `t${i}`, connected: true }));
  const game = engine.newGame('TEST', config, 42, players);
  setupGame(game, rng);
  const viewerId = game.players[0].id;
  const view = viewFor(viewerId, game);
  const ownedByViewer = game.estates.filter((e) => e.owner === viewerId).map((e) => e.id);
  for (const e of view.estates) {
    if (ownedByViewer.includes(e.id)) {
      assert.notEqual(e.grow, null, 'owner always knows their own estate');
    } else {
      // Should be null unless this player happens to already have
      // knowledge recorded (not the case right after setup).
      assert.equal(e.grow, null);
    }
  }
});

test('pending auction bids are redacted from non-participants until revealed', () => {
  const { game } = freshGame(4);
  game.pendingAuction = {
    kind: 'seizure',
    estateId: 1,
    participants: ['p0', 'p1'],
    bids: { p0: 500000, p1: 300000 },
    submitted: { p0: true, p1: true },
    revealed: false,
    deadline: Date.now() + 1000,
  };
  const viewOfP2 = viewFor('p2', game);
  assert.equal(viewOfP2.pendingAuction.bids.p0, 'submitted');
  const viewOfP0 = viewFor('p0', game);
  assert.equal(viewOfP0.pendingAuction.bids.p0, 500000);
  assert.equal(viewOfP0.pendingAuction.bids.p1, 'submitted');
});

test('estate count matches region rules for player count', () => {
  for (const n of [3, 4, 5, 6]) {
    const { game } = freshGame(n, 7 + n);
    const byPlayers = config.byPlayers[String(n)];
    const expectedRegions = byPlayers.regions === 'all' ? 5 : byPlayers.regions.length;
    const regionSet = new Set(game.estates.map((e) => e.region));
    assert.equal(regionSet.size, expectedRegions, `player count ${n}`);
  }
});
