'use strict';
const { territoriesInRegions } = require('../data/territories');
const { LORD_SIDE_CHARACTERS, POLICE_SIDE_CHARACTERS, INVESTOR_CHARACTER, CHARACTERS } = require('../data/characters');

// Okabe-Ito colorblind-safe palette (6 hues), used for player seat colours.
const PLAYER_COLORS = ['#E69F00', '#0072B2', '#009E73', '#D55E00', '#56B4E9', '#CC79A7'];

function buildActionDeck(config, rng) {
  const deck = [];
  for (const [id, count] of Object.entries(config.actionDeck)) {
    for (let i = 0; i < count; i++) deck.push(id);
  }
  return rng.shuffle(deck);
}

function buildEventDeck(config, rng) {
  const deck = [];
  for (const [id, count] of Object.entries(config.eventDeck)) {
    for (let i = 0; i < count; i++) deck.push(id);
  }
  return rng.shuffle(deck);
}

function buildLordDeck(config, rng) {
  const deck = [];
  for (const [id, def] of Object.entries(config.lordDeck)) {
    for (let i = 0; i < def.count; i++) deck.push(id);
  }
  return rng.shuffle(deck);
}

function pickCharacters(n, config, rng) {
  const roles = config.roles[String(n)];
  const policePool = rng.shuffle(POLICE_SIDE_CHARACTERS.slice()).slice(0, roles.police);
  const lordsPool = rng.shuffle(LORD_SIDE_CHARACTERS.slice()).slice(0, roles.lords);
  const candidates = [...policePool, ...lordsPool, INVESTOR_CHARACTER];

  // Remove `setAside` random candidates, but keep at least 1 police-side
  // character among those actually dealt to players.
  let setAside = [];
  let dealt = candidates.slice();
  for (let attempt = 0; attempt < 50; attempt++) {
    const pool = candidates.slice();
    const removed = [];
    for (let i = 0; i < roles.setAside; i++) removed.push(rng.draw(pool));
    const remaining = pool;
    const hasPolice = remaining.some((c) => CHARACTERS[c].side === 'police');
    if (hasPolice || roles.setAside === 0) {
      setAside = removed;
      dealt = remaining;
      break;
    }
  }
  return { dealt: rng.shuffle(dealt), setAside };
}

function setupGame(game, rng) {
  const config = game.config;
  const n = game.players.length;
  const byPlayers = config.byPlayers[String(n)];

  const territories = territoriesInRegions(byPlayers.regions);
  game.estates = territories.map((t) => ({ ...t, owner: null, grow: false }));

  // 1. Characters
  const { dealt, setAside } = pickCharacters(n, config, rng);
  game.setAside = setAside;
  const shuffledPlayers = rng.shuffle(game.players.slice());
  shuffledPlayers.forEach((p, i) => {
    const charId = dealt[i];
    p.character = charId;
    p.side = CHARACTERS[charId].side;
    p.characterInfo = CHARACTERS[charId];
  });

  // 2. Colors + 5 random estates per player
  const pool = rng.shuffle(game.estates.slice());
  game.players.forEach((p, i) => {
    p.color = PLAYER_COLORS[i % PLAYER_COLORS.length];
    p.money = config.startMoney;
    p.growCount = 0;
    p.hand = [];
    p.knowledge = {};
    p.raisedInvThisTurn = false;
    p.denunciationUsedThisTurn = false;
  });

  for (const p of game.players) {
    for (let i = 0; i < config.estatesPerPlayer; i++) {
      const t = pool.pop();
      const real = game.estates.find((e) => e.id === t.id);
      real.owner = p.id;
    }
  }

  // 3. One random grow per player on one of their own estates
  for (const p of game.players) {
    const owned = game.estates.filter((e) => e.owner === p.id);
    const chosen = rng.pick(owned);
    chosen.grow = true;
    p.growCount = config.startGrows;
  }

  // 4. Neutral grows
  const neutralEstates = rng.shuffle(game.estates.filter((e) => e.owner === null));
  for (let i = 0; i < byPlayers.neutralGrows && i < neutralEstates.length; i++) {
    neutralEstates[i].grow = true;
  }

  // 5. Money & starting hand
  game.decks = {
    action: buildActionDeck(config, rng),
    actionDiscard: [],
    event: buildEventDeck(config, rng),
    eventDiscard: [],
    lord: buildLordDeck(config, rng),
    search: rng.shuffle(game.estates.map((e) => e.id)),
    searchDiscard: [],
  };

  for (const p of game.players) {
    for (let i = 0; i < config.startCards; i++) {
      p.hand.push(game.decks.action.pop());
    }
  }

  game.investigation = byPlayers.invStart;
  game.goals = { G: byPlayers.G, E: byPlayers.E, TH: byPlayers.TH, K: byPlayers.K, IE: byPlayers.IE, IG: byPlayers.IG };
  game.round = 0;
  game.phase = 'SETUP';
  game.currentEvent = null;
  game.pendingReaction = null;
  game.pendingAuction = null;
  game.pendingLordPurchase = null;
  game.offers = [];
  game.log = [];
  game.winner = null;
  game.deadlines = {};

  return game;
}

module.exports = { setupGame, PLAYER_COLORS };
