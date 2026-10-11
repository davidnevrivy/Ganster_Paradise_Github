'use strict';
const { goalProgress } = require('./goals');

/**
 * THE most important function in this codebase: builds the per-player view
 * of game state. Must never leak information the given player is not
 * entitled to (acceptance criterion: "žádná zpráva neobsahuje skrytou
 * informaci jiného hráče"). Covered by tests/view.test.js.
 *
 * Rule of thumb applied throughout: redact at the *source* (here), never
 * rely on the client to hide fields it already received.
 */
function viewFor(viewerId, game) {
  const over = game.phase === 'GAME_OVER';

  const estates = game.estates.map((e) => {
    const known = e.owner === viewerId
      ? { grow: e.grow, round: game.round, live: true }
      : over
        ? { grow: e.grow, round: game.round, live: true }
        : knowledgeFor(game, viewerId, e.id);
    return {
      id: e.id,
      region: e.region,
      regionLabel: e.regionLabel,
      name: e.name,
      x: e.x,
      y: e.y,
      owner: e.owner,
      grow: known ? known.grow : null, // null = unknown to this viewer
      knownRound: known ? known.round : null,
      stale: !!(known && !known.live && known.round < game.round),
    };
  });

  const players = game.players.map((p) => {
    const self = p.id === viewerId;
    const base = {
      id: p.id,
      nick: p.nick,
      color: p.color,
      growCount: p.growCount,
      cardCount: p.hand.length,
      connected: p.connected,
      estateCount: game.estates.filter((e) => e.owner === p.id).length,
    };
    if (self || over) {
      base.character = p.character;
      base.side = p.side;
      base.money = p.money;
      base.hand = p.hand;
    }
    return base;
  });

  const me = game.players.find((p) => p.id === viewerId);

  return {
    id: game.id,
    seed: over ? game.seed : undefined, // seed only revealed at game end (debug/replay), never mid-game to avoid players computing deck order
    round: game.round,
    phase: game.phase,
    turnOrder: game.turnOrder,
    activePlayer: game.activePlayer,
    actionsLeft: game.actionsLeft,
    freeCardUsed: game.freeCardUsed,
    investigation: game.investigation,
    goals: game.goals,
    autoRaidThreshold: game.config.investigation.autoRaidFrom,
    currentEvent: game.currentEvent,
    decks: {
      actionCount: game.decks.action.length,
      eventCount: game.decks.event.length,
      lordCount: game.decks.lord.length,
      searchCount: game.decks.search.length,
    },
    estates,
    players,
    myGoalProgress: me ? goalProgress(game, viewerId) : null,
    myCharacterInfo: me ? me.characterInfo : null,
    pendingReaction: sanitizeReaction(game.pendingReaction, viewerId),
    pendingAuction: sanitizeAuction(game.pendingAuction, viewerId),
    pendingLordPurchase: sanitizeLordPurchase(game.pendingLordPurchase, viewerId),
    myPendingDiscard: game.pendingDiscard[viewerId] || null,
    myPendingDebt: game.pendingDebt[viewerId] || null,
    offers: game.offers.map((o) => sanitizeOffer(o, viewerId)),
    log: game.log,
    winner: game.winner,
    setAside: over ? game.setAside : undefined,
    deadlines: game.deadlines,
    timers: game.config.timers,
  };
}

function knowledgeFor(game, viewerId, estateId) {
  const player = game.players.find((p) => p.id === viewerId);
  if (!player) return null;
  const k = player.knowledge[estateId];
  return k || null;
}

function sanitizeReaction(r, viewerId) {
  if (!r) return null;
  // Everyone sees that a reaction window is open and for which estate once
  // the raid target has been chosen/announced, and who must react.
  return {
    type: r.type,
    estateId: r.estateId,
    attacker: r.attacker || null,
    awaiting: r.awaiting,
    sourceCharacter: r.sourceCharacter || null,
    canBribe: !!r.canBribe,
    canFalseLead: !!r.canFalseLead,
    canRefuse: !!r.canRefuse,
    canLawyer: !!r.canLawyer,
    history: r.history || null,
    deadline: r.deadline,
  };
}

function sanitizeAuction(a, viewerId) {
  if (!a) return null;
  const bids = {};
  for (const pid of Object.keys(a.bids)) {
    if (a.revealed || pid === viewerId) bids[pid] = a.bids[pid];
    else bids[pid] = a.submitted[pid] ? 'submitted' : null;
  }
  return {
    kind: a.kind, // 'seizure' | 'succession'
    estateId: a.estateId,
    participants: a.participants,
    bids,
    revealed: a.revealed,
    deadline: a.deadline,
    result: a.result || null,
  };
}

function sanitizeLordPurchase(lp, viewerId) {
  if (!lp) return null;
  // Lord card identity is public the instant it is flipped (per rules: "po
  // koupi hráč vidí žeton" is about the estate's grow token, not the lord
  // card, which is public immediately). So no redaction needed here.
  return lp;
}

function sanitizeOffer(offer, viewerId) {
  const involved = offer.from === viewerId || offer.to === viewerId;
  if (involved || offer.status !== 'open') {
    return offer;
  }
  // Other players only see that an offer exists between A and B, not terms.
  return { id: offer.id, from: offer.from, to: offer.to, status: offer.status, hidden: true };
}

module.exports = { viewFor };
