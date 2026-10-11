'use strict';
const { setupGame } = require('./setup');
const { checkGoal } = require('./goals');

const now = () => Date.now();

function log(game, text, data) {
  game.log.push({ id: game.log.length + 1, round: game.round, phase: game.phase, text, data: data || null, ts: now() });
}

function clampMoney(player, amount) {
  // "Do mínusu se nikdy nejde" — paying more than you have pays everything.
  const pay = Math.min(amount, player.money);
  player.money -= pay;
  return pay;
}

function recycleToBottom(deck, cardId) {
  deck.unshift(cardId);
}

function drawFromDeck(game, deckName, discardName) {
  const deck = game.decks[deckName];
  if (deck.length === 0 && discardName) {
    const discard = game.decks[discardName];
    while (discard.length) deck.push(discard.pop());
    // reshuffle in place using a fresh unseeded pass is NOT deterministic;
    // instead we keep whatever order discard accumulated — acceptable
    // because the *initial* shuffle already used the seeded RNG and the
    // discard order itself is a deterministic function of prior play.
  }
  return deck.pop();
}

function discardCard(game, playerId, cardId) {
  const player = getPlayer(game, playerId);
  const idx = player.hand.indexOf(cardId);
  if (idx >= 0) player.hand.splice(idx, 1);
  game.decks.actionDiscard.push(cardId);
}

function getPlayer(game, id) {
  return game.players.find((p) => p.id === id);
}
function getEstate(game, id) {
  return game.estates.find((e) => e.id === id);
}
function estateCountOf(game, playerId) {
  return game.estates.filter((e) => e.owner === playerId).length;
}
function isRegionLord(game, playerId, region) {
  const counts = {};
  for (const e of game.estates) {
    if (!e.owner) continue;
    counts[e.owner] = counts[e.owner] || {};
  }
  const perOwnerInRegion = {};
  for (const e of game.estates.filter((e) => e.region === region)) {
    if (!e.owner) continue;
    perOwnerInRegion[e.owner] = (perOwnerInRegion[e.owner] || 0) + 1;
  }
  const max = Math.max(0, ...Object.values(perOwnerInRegion));
  if (max === 0) return false;
  const leaders = Object.keys(perOwnerInRegion).filter((pid) => perOwnerInRegion[pid] === max);
  return leaders.length === 1 && leaders[0] === playerId;
}
function transferEstateOwnership(game, estate, toPlayerId) {
  // Centralised so growCount (public per-player counter) always stays in
  // sync with the token physically following ownership ("Převod panství s
  // pěstírnou: pěstírna i počítadlo se převádí").
  const fromPlayerId = estate.owner;
  if (fromPlayerId === toPlayerId) return;
  if (estate.grow) {
    if (fromPlayerId) getPlayer(game, fromPlayerId).growCount -= 1;
    if (toPlayerId) getPlayer(game, toPlayerId).growCount += 1;
  }
  estate.owner = toPlayerId;
}

function revealToAll(game, estateId) {
  const estate = getEstate(game, estateId);
  for (const p of game.players) {
    p.knowledge[estateId] = { grow: estate.grow, round: game.round, live: true };
  }
}
function revealToPlayer(game, viewerId, estateId) {
  const estate = getEstate(game, estateId);
  const player = getPlayer(game, viewerId);
  player.knowledge[estateId] = { grow: estate.grow, round: game.round, live: true };
}

// ---------------------------------------------------------------------------
// Game creation / round flow
// ---------------------------------------------------------------------------

function newGame(id, config, seed, players) {
  return {
    id,
    config,
    seed,
    players, // [{id, nick, token, connected, socketId}]
    estates: [],
    decks: {},
    round: 0,
    phase: 'LOBBY',
    turnOrder: [],
    turnIndex: 0,
    activePlayer: null,
    actionsLeft: 0,
    freeCardUsed: false,
    investigation: 0,
    goals: {},
    setAside: [],
    currentEvent: null,
    pendingReaction: null,
    pendingAuction: null,
    pendingLordPurchase: null,
    pendingDiscard: {}, // playerId -> {need, deadline}
    pendingDebt: {}, // playerId -> {deadline}
    offers: [],
    log: [],
    winner: null,
    deadlines: {},
    readyNegotiation: [],
    error: null,
  };
}

function startGame(game, rng) {
  setupGame(game, rng);
  log(game, 'Hra začíná.');
  beginRound(game, rng);
}

function beginRound(game, rng) {
  game.round += 1;
  if (game.round > game.config.maxRounds) {
    game.phase = 'GAME_OVER';
    game.winner = null;
    game.error = 'MAX_ROUNDS_EXCEEDED';
    log(game, `Pojistka: hra překročila ${game.config.maxRounds} kol bez vítěze.`);
    return;
  }
  game.phase = 'ROUND_EVENT';
  game.readyNegotiation = [];
  for (const p of game.players) {
    p.raisedInvThisTurn = false;
    p.denunciationUsedThisTurn = false;
  }
  resolveEvent(game, rng);
}

function resolveEvent(game, rng) {
  const eventId = drawFromDeck(game, 'event', 'eventDiscard');
  game.decks.eventDiscard.push(eventId);
  game.currentEvent = eventId;
  const cfg = game.config;
  switch (eventId) {
    case 'pozornost':
      game.investigation = Math.min(cfg.investigation.max, game.investigation + 2);
      log(game, 'Událost: Zvýšená pozornost policie. Vyšetřování +2.');
      break;
    case 'bulvar': {
      const estateId = drawSearchCard(game);
      if (estateId != null) {
        revealToAll(game, estateId);
        log(game, `Událost: Bulvár. Žeton panství ${estateId} je odhalen všem.`);
      }
      break;
    }
    case 'plisen': {
      const estateId = drawSearchCard(game);
      if (estateId != null) {
        const estate = getEstate(game, estateId);
        revealToAll(game, estateId);
        if (estate.grow) {
          estate.grow = false;
          if (estate.owner) {
            const owner = getPlayer(game, estate.owner);
            owner.growCount -= 1;
          }
          log(game, `Událost: Plíseň zničila pěstírnu na panství ${estateId} (bez pokuty, bez dražby).`);
        } else {
          log(game, `Událost: Plíseň — panství ${estateId} bylo bez pěstírny.`);
        }
      }
      break;
    }
    case 'sklizen':
      log(game, 'Událost: Dobrá sklizeň. Příjem za pěstírny bude tajně navýšen.');
      break;
    case 'klid':
      game.investigation = Math.max(0, game.investigation - 2);
      log(game, 'Událost: Klidné kolo. Vyšetřování −2.');
      break;
    case 'dluh':
      log(game, 'Událost: Dluh u bookmakera. Každý zaplatí 200 000 £ nebo vrátí panství.');
      break;
    default:
      break;
  }
  goToIncome(game, rng);
}

function drawSearchCard(game) {
  if (game.decks.search.length === 0) {
    while (game.decks.searchDiscard.length) game.decks.search.push(game.decks.searchDiscard.pop());
  }
  const id = game.decks.search.pop();
  if (id != null) game.decks.searchDiscard.push(id);
  return id;
}

function goToIncome(game, rng) {
  game.phase = 'ROUND_INCOME';
  const cfg = game.config;
  for (const p of game.players) {
    let income = cfg.income;
    for (const region of new Set(game.estates.map((e) => e.region))) {
      if (isRegionLord(game, p.id, region)) income += cfg.regionLordBonus;
    }
    if (p.character === 'vymahac') income += cfg.abilities.vymahacIncome;
    if (game.currentEvent === 'sklizen') income += p.growCount * cfg.costs.harvestPerGrow;
    p.money += income;
    for (let i = 0; i < cfg.incomeCards; i++) {
      const card = drawFromDeck(game, 'action', 'actionDiscard');
      if (card) p.hand.push(card);
    }
  }
  log(game, 'Příjem vyplacen, karty rozdány.');

  if (game.currentEvent === 'dluh') {
    for (const p of game.players) {
      if (p.money >= cfg.costs.debt) {
        p.money -= cfg.costs.debt;
      } else {
        const owned = game.estates.filter((e) => e.owner === p.id);
        if (owned.length === 0) continue;
        game.pendingDebt[p.id] = { deadline: now() + 15000, candidates: owned.map((e) => e.id) };
      }
    }
  }
  goToNegotiation(game);
}

function goToNegotiation(game) {
  game.phase = 'NEGOTIATION';
  game.readyNegotiation = [];
  game.deadlines.negotiation = now() + game.config.timers.negotiationSec * 1000;
}

function goToTurns(game, rng) {
  game.phase = 'TURNS';
  game.turnOrder = rng.shuffle(game.players.map((p) => p.id));
  game.turnIndex = -1;
  advanceTurn(game, rng);
}

function advanceTurn(game, rng) {
  game.turnIndex += 1;
  if (game.turnIndex >= game.turnOrder.length) {
    endRound(game, rng);
    return;
  }
  game.activePlayer = game.turnOrder[game.turnIndex];
  game.actionsLeft = 2;
  game.freeCardUsed = false;
  const player = getPlayer(game, game.activePlayer);
  const freeCard = drawFromDeck(game, 'action', 'actionDiscard');
  if (freeCard) {
    player.hand.push(freeCard);
    game.freeCardUsed = true;
  }
  game.deadlines.turn = now() + game.config.timers.turnSec * 1000;
  log(game, `${player.nick} je na tahu.`);
}

function endTurnIfDone(game, rng) {
  if (game.pendingReaction || game.pendingAuction || game.pendingLordPurchase) return;
  if (game.actionsLeft <= 0) {
    const winner = checkGoal(game, game.activePlayer);
    if (winner) {
      finishGame(game, winner);
      return;
    }
    advanceTurn(game, rng);
  }
}

function endRound(game, rng) {
  game.phase = 'ROUND_END';
  const cfg = game.config;
  game.investigation = Math.min(cfg.investigation.max, game.investigation + cfg.investigation.endOfRound);
  log(game, `Konec kola. Vyšetřování +1 (nyní ${game.investigation}).`);

  if (game.investigation >= cfg.investigation.autoRaidFrom) {
    for (let i = 0; i < cfg.investigation.autoRaids; i++) {
      const estateId = drawSearchCard(game);
      if (estateId == null) continue;
      const estate = getEstate(game, estateId);
      const owner = estate.owner ? getPlayer(game, estate.owner) : null;
      if (owner && owner.character === 'pestitel' && cfg.abilities.pestitelAutoRaidImmune) {
        log(game, 'Automatická razie se nezdařila — pátrací karta propadla.');
        continue;
      }
      startRaid(game, estateId, { source: 'auto' });
      if (game.pendingReaction || game.pendingAuction) {
        // Automatic raids resolve synchronously except for the reaction
        // window, which needs real player input; defer remaining auto
        // raids until this one fully resolves (handled by tick()).
        game.pendingAutoRaidsRemaining = cfg.investigation.autoRaids - i - 1;
        return;
      }
    }
  }
  enforceHandLimit(game);
  if (game.phase === 'ROUND_END') {
    beginRound(game, rng);
  }
}

function enforceHandLimit(game) {
  const cfg = game.config;
  for (const p of game.players) {
    if (p.hand.length > cfg.handLimit) {
      game.pendingDiscard[p.id] = { need: p.hand.length - cfg.handLimit, deadline: now() + 15000 };
    }
  }
}

function allHandLimitsClear(game) {
  return Object.keys(game.pendingDiscard).length === 0;
}

function finishGame(game, winner) {
  game.phase = 'GAME_OVER';
  game.winner = winner;
  log(game, `${getPlayer(game, winner.playerId).nick} vyhrává hru!`);
}

// ---------------------------------------------------------------------------
// Raids & reaction windows
// ---------------------------------------------------------------------------

function startRaid(game, estateId, { source, sourceCharacter }) {
  const estate = getEstate(game, estateId);
  const owner = estate.owner ? getPlayer(game, estate.owner) : null;
  const inspectorLocked = sourceCharacter === 'inspektor';

  if (!owner) {
    resolveRevealAndConsequence(game, estateId, { source, sourceCharacter });
    return;
  }

  const canBribe = !inspectorLocked && owner.hand.includes('uplatek') && owner.character !== 'inspektor' &&
    owner.money >= bribeCost(game, owner);
  const canFalseLead = !inspectorLocked && owner.hand.includes('falesna') &&
    falseLeadCandidates(game, owner.id, [estateId]).length > 0;

  game.pendingReaction = {
    type: 'raid',
    estateId,
    awaiting: owner.id,
    sourceCharacter: sourceCharacter || null,
    source,
    canBribe,
    canFalseLead,
    history: [estateId],
    deadline: now() + game.config.timers.reactionSec * 1000,
  };
}

function bribeCost(game, owner) {
  return owner.character === 'celnik' ? game.config.abilities.celnikBribe : game.config.costs.bribe;
}

function falseLeadCandidates(game, excludeOwnerId, history) {
  return game.estates.filter((e) => e.owner && e.owner !== excludeOwnerId && !history.includes(e.id));
}

function resolveReaction(game, playerId, choice, payload, rng) {
  const r = game.pendingReaction;
  if (!r || r.awaiting !== playerId) return { error: 'NOT_YOUR_REACTION' };
  const owner = getPlayer(game, playerId);

  if (choice === 'bribe' && r.canBribe) {
    discardCard(game, playerId, 'uplatek');
    const cost = bribeCost(game, owner);
    clampMoney(owner, cost);
    log(game, `${owner.nick} zahrál Úplatek. Razie zrušena.`);
    game.pendingReaction = null;
    afterReactionResolved(game, rng);
    return {};
  }
  if (choice === 'false_lead' && r.canFalseLead) {
    const candidates = falseLeadCandidates(game, playerId, r.history);
    const targetId = payload && candidates.find((e) => e.id === payload.estateId) ? payload.estateId : candidates[0].id;
    discardCard(game, playerId, 'falesna');
    log(game, `${owner.nick} zahrál Falešnou stopu.`);
    const newOwnerEstate = getEstate(game, targetId);
    const newOwner = getPlayer(game, newOwnerEstate.owner);
    const history = [...r.history, targetId];
    const inspectorLocked = r.sourceCharacter === 'inspektor';
    const canBribe = !inspectorLocked && newOwner.hand.includes('uplatek') && newOwner.character !== 'inspektor' &&
      newOwner.money >= bribeCost(game, newOwner);
    const canFalseLead = !inspectorLocked && newOwner.hand.includes('falesna') &&
      falseLeadCandidates(game, newOwner.id, history).length > 0;
    game.pendingReaction = {
      type: 'raid',
      estateId: targetId,
      awaiting: newOwner.id,
      sourceCharacter: r.sourceCharacter,
      source: r.source,
      canBribe,
      canFalseLead,
      history,
      deadline: now() + game.config.timers.reactionSec * 1000,
    };
    return {};
  }
  // pass / no valid reaction
  const estateId = r.estateId;
  const sourceInfo = { source: r.source, sourceCharacter: r.sourceCharacter };
  game.pendingReaction = null;
  resolveRevealAndConsequence(game, estateId, sourceInfo);
  afterReactionResolved(game, rng);
  return {};
}

function resolveRevealAndConsequence(game, estateId, { source, sourceCharacter }) {
  const estate = getEstate(game, estateId);
  revealToAll(game, estateId);
  log(game, `Razie: žeton panství ${estateId} odhalen.`);
  if (!estate.grow) {
    log(game, 'Prázdný sklep — bez dalšího účinku.');
    return;
  }
  estate.grow = false;
  if (!estate.owner) {
    log(game, 'Pěstírna na neutrálním panství zničena (bez pokuty, bez dražby).');
    return;
  }
  const owner = getPlayer(game, estate.owner);
  owner.growCount -= 1;
  const fine = clampMoney(owner, game.config.costs.raidFine);
  log(game, `Pěstírna hráče ${owner.nick} zničena, pokuta ${fine.toLocaleString('cs-CZ')} £.`);
  const previousOwnerId = owner.id;
  estate.owner = null;
  startSeizureAuction(game, estateId, previousOwnerId);
}

function afterReactionResolved(game, rng) {
  if (game.pendingReaction || game.pendingAuction) return;
  if (game.phase === 'ROUND_END') {
    const remaining = game.pendingAutoRaidsRemaining || 0;
    game.pendingAutoRaidsRemaining = 0;
    if (remaining > 0) {
      for (let i = 0; i < remaining; i++) {
        const estateId = drawSearchCard(game);
        if (estateId == null) continue;
        const estate = getEstate(game, estateId);
        const owner = estate.owner ? getPlayer(game, estate.owner) : null;
        if (owner && owner.character === 'pestitel' && game.config.abilities.pestitelAutoRaidImmune) continue;
        startRaid(game, estateId, { source: 'auto' });
        if (game.pendingReaction || game.pendingAuction) {
          game.pendingAutoRaidsRemaining = remaining - i - 1;
          return;
        }
      }
    }
    enforceHandLimit(game);
    if (allHandLimitsClear(game) && game.phase === 'ROUND_END') beginRound(game, rng);
  } else if (game.phase === 'TURNS') {
    endTurnIfDone(game, rng);
  }
}

// ---------------------------------------------------------------------------
// Auctions
// ---------------------------------------------------------------------------

function startSeizureAuction(game, estateId, previousOwnerId) {
  const previousOwner = getPlayer(game, previousOwnerId);
  const participants = game.players
    .filter((p) => !(p.id === previousOwnerId && previousOwner.character === 'dedic'))
    .map((p) => p.id);
  game.pendingAuction = {
    kind: 'seizure',
    estateId,
    participants,
    bids: {},
    submitted: {},
    revealed: false,
    deadline: now() + game.config.timers.auctionSec * 1000,
    result: null,
  };
}

function startSuccessionAuction(game, estateId, attackerId, defenderId) {
  game.pendingAuction = {
    kind: 'succession',
    estateId,
    participants: [attackerId, defenderId],
    attacker: attackerId,
    defender: defenderId,
    bids: {},
    submitted: {},
    revealed: false,
    deadline: now() + game.config.timers.auctionSec * 1000,
    result: null,
  };
}

function minBidFor(game, player) {
  if (player.character === 'celnik' && player.money >= game.config.abilities.celnikMinBid) {
    return game.config.abilities.celnikMinBid;
  }
  return 0;
}

function submitBid(game, playerId, amount) {
  const a = game.pendingAuction;
  if (!a || !a.participants.includes(playerId)) return { error: 'NOT_A_PARTICIPANT' };
  const player = getPlayer(game, playerId);
  const min = minBidFor(game, player);
  let bid = Math.max(0, Math.min(player.money, Math.round(amount / 100000) * 100000));
  if (bid < min) bid = min;
  a.bids[playerId] = bid;
  a.submitted[playerId] = true;
  return {};
}

function allBidsIn(game) {
  const a = game.pendingAuction;
  return a && a.participants.every((pid) => a.submitted[pid]);
}

function resolveAuctionIfReady(game, rng) {
  const a = game.pendingAuction;
  if (!a) return;
  if (!allBidsIn(game)) return;
  for (const pid of a.participants) {
    if (!a.submitted[pid]) {
      const player = getPlayer(game, pid);
      a.bids[pid] = minBidFor(game, player);
      a.submitted[pid] = true;
    }
  }
  a.revealed = true;
  const estate = getEstate(game, a.estateId);

  if (a.kind === 'seizure') {
    const max = Math.max(...a.participants.map((pid) => a.bids[pid]));
    const winners = a.participants.filter((pid) => a.bids[pid] === max);
    if (max === 0 || winners.length !== 1) {
      estate.owner = null;
      a.result = { outcome: 'neutral' };
      log(game, `Dražba panství ${a.estateId}: shoda na nejvyšší nebo vše 0 — panství zůstává neutrální.`);
    } else {
      const winnerId = winners[0];
      const winner = getPlayer(game, winnerId);
      clampMoney(winner, max);
      transferEstateOwnership(game, estate, winnerId);
      a.result = { outcome: 'sold', winner: winnerId, price: max };
      log(game, `Dražba panství ${a.estateId}: vítěz ${winner.nick} za ${max.toLocaleString('cs-CZ')} £.`);
    }
  } else {
    const attacker = getPlayer(game, a.attacker);
    const defender = getPlayer(game, a.defender);
    let attackerBid = a.bids[a.attacker];
    let defenderBid = a.bids[a.defender];
    if (attacker.character === 'vymahac') attackerBid += game.config.abilities.vymahacAuctionBonus;
    if (defender.character === 'vymahac') defenderBid += game.config.abilities.vymahacAuctionBonus;
    if (attackerBid > defenderBid) {
      clampMoney(attacker, a.bids[a.attacker]);
      transferEstateOwnership(game, estate, a.attacker);
      a.result = { outcome: 'attacker', price: a.bids[a.attacker] };
      log(game, `Dědické řízení o panství ${a.estateId}: útočník ${attacker.nick} vítězí.`);
    } else {
      clampMoney(defender, a.bids[a.defender]);
      a.result = { outcome: 'defender', price: a.bids[a.defender] };
      log(game, `Dědické řízení o panství ${a.estateId}: majitel ${defender.nick} obhájil panství.`);
    }
  }
  game.pendingAuction = null;
  afterReactionResolved(game, rng);
}

// ---------------------------------------------------------------------------
// Turn actions
// ---------------------------------------------------------------------------

function requireActivePlayer(game, playerId) {
  if (game.phase !== 'TURNS') return 'NOT_IN_TURNS';
  if (game.activePlayer !== playerId) return 'NOT_YOUR_TURN';
  if (game.pendingReaction || game.pendingAuction || game.pendingLordPurchase) return 'ACTION_PENDING';
  if (game.actionsLeft <= 0) return 'NO_ACTIONS_LEFT';
  return null;
}

function spendAction(game) {
  game.actionsLeft -= 1;
}

const turnActions = {
  draw_card(game, player) {
    const card = drawFromDeck(game, 'action', 'actionDiscard');
    if (card) player.hand.push(card);
    log(game, `${player.nick} táhl kartu.`);
    spendAction(game);
    return {};
  },

  buy_cards(game, player) {
    const cost = game.config.costs.buyCards;
    if (player.money < cost) return { error: 'INSUFFICIENT_FUNDS' };
    player.money -= cost;
    for (let i = 0; i < 2; i++) {
      const card = drawFromDeck(game, 'action', 'actionDiscard');
      if (card) player.hand.push(card);
    }
    log(game, `${player.nick} koupil 2 karty.`);
    spendAction(game);
    return {};
  },

  buy_estate(game, player, payload) {
    const estate = getEstate(game, payload.estateId);
    if (!estate || estate.owner !== null) return { error: 'NOT_NEUTRAL' };
    const lordType = drawFromDeck(game, 'lord', null);
    const def = game.config.lordDeck[lordType];
    if (lordType === 'dispute') {
      game.investigation = Math.min(game.config.investigation.max, game.investigation + 1);
      log(game, `${player.nick} narazil na Lorda ve sporu — panství ${estate.id} neprodá. Vyšetřování +1.`);
      recycleToBottom(game.decks.lord, lordType);
      spendAction(game);
      return {};
    }
    let price = def.cost;
    if (player.character === 'dedic') price -= game.config.abilities.dedicBuyDiscount;
    if (player.character === 'investor' && lordType === 'normal') price -= game.config.abilities.investorDiscountNormalLord;
    price = Math.max(0, price);
    if (lordType === 'gossip') {
      game.investigation = Math.min(game.config.investigation.max, game.investigation + 1);
    }
    game.pendingLordPurchase = { estateId: estate.id, lordType, price, playerId: player.id };
    log(game, `${player.nick} otočil kartu lorda (${lordType}) pro panství ${estate.id}.`);
    spendAction(game);
    return {};
  },

  sow(game, player, payload) {
    const estate = getEstate(game, payload.estateId);
    if (!estate || estate.owner !== player.id || estate.grow) return { error: 'INVALID_TARGET' };
    const cost = player.character === 'pestitel' ? game.config.abilities.pestitelSow : game.config.costs.sow;
    if (player.money < cost) return { error: 'INSUFFICIENT_FUNDS' };
    player.money -= cost;
    estate.grow = true;
    player.growCount += 1;
    if (player.character !== 'pestitel' && !player.raisedInvThisTurn) {
      game.investigation = Math.min(game.config.investigation.max, game.investigation + 1);
      player.raisedInvThisTurn = true;
    }
    log(game, `${player.nick} zasel.`);
    spendAction(game);
    return {};
  },

  check(game, player, payload) {
    const estate = getEstate(game, payload.estateId);
    if (!estate) return { error: 'INVALID_TARGET' };
    const cost = player.character === 'hrabe' ? game.config.abilities.hrabeCheck : game.config.costs.check;
    if (player.money < cost) return { error: 'INSUFFICIENT_FUNDS' };
    player.money -= cost;
    revealToPlayer(game, player.id, estate.id);
    log(game, `${player.nick} použil Prověř.`);
    spendAction(game);
    return {};
  },

  denounce(game, player, payload) {
    if (player.denunciationUsedThisTurn) return { error: 'ALREADY_DENOUNCED' };
    const estate = getEstate(game, payload.estateId);
    if (!estate || !estate.owner || estate.owner === player.id) return { error: 'INVALID_TARGET' };
    const cost = game.config.costs.denounce;
    if (player.money < cost) return { error: 'INSUFFICIENT_FUNDS' };
    player.money -= cost;
    revealToPlayer(game, player.id, estate.id);
    game.investigation = Math.min(game.config.investigation.max, game.investigation + 1);
    player.denunciationUsedThisTurn = true;
    const target = getPlayer(game, estate.owner);
    log(game, `${player.nick} udal panství ${estate.name} hráče ${target.nick}. Vyšetřování +1.`);
    spendAction(game);
    return {};
  },

  play_card(game, player, payload, rng) {
    const cardId = payload.cardId;
    if (!player.hand.includes(cardId)) return { error: 'CARD_NOT_IN_HAND' };
    const result = playCard(game, player, cardId, payload, rng);
    if (result.error) return result;
    spendAction(game);
    return {};
  },
};

function playCard(game, player, cardId, payload, rng) {
  switch (cardId) {
    case 'informator': {
      const n = player.character === 'hrabe' ? game.config.abilities.hrabeInformant : 2;
      const ids = (payload.estateIds || []).slice(0, n);
      if (ids.length === 0) return { error: 'NO_TARGETS' };
      discardCard(game, player.id, cardId);
      for (const id of ids) {
        if (getEstate(game, id)) revealToPlayer(game, player.id, id);
      }
      log(game, `${player.nick} hrál kartu Informátor.`);
      return {};
    }
    case 'razie': {
      const estate = getEstate(game, payload.estateId);
      if (!estate) return { error: 'INVALID_TARGET' };
      discardCard(game, player.id, cardId);
      log(game, `${player.nick} hrál kartu Razie.`);
      startRaid(game, estate.id, { source: 'card', sourceCharacter: player.character });
      return {};
    }
    case 'nabidka': {
      const estate = getEstate(game, payload.estateId);
      if (!estate || !estate.owner || estate.owner === player.id) return { error: 'INVALID_TARGET' };
      if (player.money < game.config.costs.offerPay) return { error: 'INSUFFICIENT_FUNDS' };
      discardCard(game, player.id, cardId);
      const defender = getPlayer(game, estate.owner);
      const canRefuse = player.character !== 'vymahac' && defender.character !== 'investor' &&
        defender.money >= game.config.costs.offerRefuse;
      game.pendingReaction = {
        type: 'hostile_offer',
        estateId: estate.id,
        attacker: player.id,
        awaiting: defender.id,
        canRefuse,
        canLawyer: defender.hand.includes('pravnik') && defender.character !== 'vymahac',
        deadline: now() + game.config.timers.reactionSec * 1000,
      };
      log(game, `${player.nick} hrál Nepřátelskou nabídku na panství ${estate.name}.`);
      return {};
    }
    case 'cerny': {
      const estate = getEstate(game, payload.estateId);
      if (!estate || estate.owner !== player.id || !estate.grow) return { error: 'INVALID_TARGET' };
      discardCard(game, player.id, cardId);
      estate.grow = false;
      player.growCount -= 1;
      player.money += game.config.costs.blackMarketPerGrow;
      log(game, `${player.nick} hrál Černý trh.`);
      return {};
    }
    case 'kompro': {
      const target = getPlayer(game, payload.targetPlayerId);
      if (!target || target.id === player.id) return { error: 'INVALID_TARGET' };
      discardCard(game, player.id, cardId);
      game.pendingReaction = {
        type: 'kompro',
        attacker: player.id,
        awaiting: target.id,
        canLawyer: target.hand.includes('pravnik') && target.character !== 'vymahac',
        deadline: now() + game.config.timers.reactionSec * 1000,
      };
      log(game, `${player.nick} hrál Kompromitující materiál.`);
      return {};
    }
    case 'presun': {
      if (player.character === 'pestitel') return { error: 'FORBIDDEN_FOR_CHARACTER' };
      const [aId, bId] = payload.estateIds || [];
      const a = getEstate(game, aId);
      const b = getEstate(game, bId);
      if (!a || !b || a.owner !== player.id || b.owner !== player.id || aId === bId) return { error: 'INVALID_TARGET' };
      discardCard(game, player.id, cardId);
      const tmp = a.grow;
      a.grow = b.grow;
      b.grow = tmp;
      log(game, `${player.nick} hrál Přesun úrody.`);
      return {};
    }
    case 'dedicke': {
      const estate = getEstate(game, payload.estateId);
      if (!estate || !estate.owner || estate.owner === player.id) return { error: 'INVALID_TARGET' };
      discardCard(game, player.id, cardId);
      const defender = getPlayer(game, estate.owner);
      log(game, `${player.nick} hrál Dědické řízení na panství ${estate.name}.`);
      // "Proti tobě" card — only the target may cancel it with Právník,
      // same as Nepřátelská nabídka / Kompro, before the auction opens.
      game.pendingReaction = {
        type: 'dedicke',
        estateId: estate.id,
        attacker: player.id,
        awaiting: defender.id,
        canLawyer: defender.hand.includes('pravnik') && defender.character !== 'vymahac',
        deadline: now() + game.config.timers.reactionSec * 1000,
      };
      return {};
    }
    default:
      return { error: 'UNKNOWN_OR_REACTION_ONLY_CARD' };
  }
}

// ---------------------------------------------------------------------------
// Responses to pendingReaction of type hostile_offer / kompro
// ---------------------------------------------------------------------------

function resolveHostileOffer(game, playerId, choice) {
  const r = game.pendingReaction;
  if (!r || r.type !== 'hostile_offer' || r.awaiting !== playerId) return { error: 'NOT_YOUR_REACTION' };
  const defender = getPlayer(game, playerId);
  const attacker = getPlayer(game, r.attacker);
  const estate = getEstate(game, r.estateId);

  if (choice === 'lawyer' && r.canLawyer) {
    discardCard(game, playerId, 'pravnik');
    log(game, `${defender.nick} zahrál Právníka. Nabídka zrušena.`);
  } else if (choice === 'refuse' && r.canRefuse) {
    const paid = clampMoney(defender, game.config.costs.offerRefuse);
    attacker.money += paid;
    log(game, `${defender.nick} odmítl nabídku za ${paid.toLocaleString('cs-CZ')} £.`);
  } else {
    // accept (default, or forced because cannot refuse)
    const paid = Math.min(game.config.costs.offerPay, attacker.money);
    attacker.money -= paid;
    defender.money += paid;
    transferEstateOwnership(game, estate, attacker.id);
    log(game, `${attacker.nick} koupil panství ${estate.name} Nepřátelskou nabídkou za ${paid.toLocaleString('cs-CZ')} £.`);
  }
  game.pendingReaction = null;
  return {};
}

function resolveKompro(game, playerId, choice, payload) {
  const r = game.pendingReaction;
  if (!r || r.type !== 'kompro' || r.awaiting !== playerId) return { error: 'NOT_YOUR_REACTION' };
  const target = getPlayer(game, playerId);
  const attacker = getPlayer(game, r.attacker);

  if (choice === 'lawyer' && r.canLawyer) {
    discardCard(game, playerId, 'pravnik');
    log(game, `${target.nick} zahrál Právníka. Vydírání zrušeno.`);
  } else if (choice === 'money' || target.character === 'hrabe') {
    const paid = clampMoney(target, game.config.costs.kompro);
    attacker.money += paid;
    log(game, `${target.nick} zaplatil ${paid.toLocaleString('cs-CZ')} £.`);
  } else {
    const n = Math.min(2, target.hand.length);
    const chosen = (payload && payload.cardIds && payload.cardIds.length === n)
      ? payload.cardIds
      : target.hand.slice(0, n);
    for (const c of chosen) {
      const idx = target.hand.indexOf(c);
      if (idx >= 0) {
        target.hand.splice(idx, 1);
        attacker.hand.push(c);
      }
    }
    log(game, `${target.nick} předal ${n} karty.`);
  }
  game.pendingReaction = null;
  return {};
}

function resolveDedickeReaction(game, playerId, choice) {
  const r = game.pendingReaction;
  if (!r || r.type !== 'dedicke' || r.awaiting !== playerId) return { error: 'NOT_YOUR_REACTION' };
  const defender = getPlayer(game, playerId);
  game.pendingReaction = null;
  if (choice === 'lawyer' && r.canLawyer) {
    discardCard(game, playerId, 'pravnik');
    log(game, `${defender.nick} zahrál Právníka. Dědické řízení zrušeno.`);
    return {};
  }
  startSuccessionAuction(game, r.estateId, r.attacker, playerId);
  return {};
}

// ---------------------------------------------------------------------------
// Lord purchase confirmation
// ---------------------------------------------------------------------------

function confirmLordPurchase(game, playerId, accept) {
  const lp = game.pendingLordPurchase;
  if (!lp || lp.playerId !== playerId) return { error: 'NO_PENDING_PURCHASE' };
  const player = getPlayer(game, playerId);
  const estate = getEstate(game, lp.estateId);
  if (accept && player.money >= lp.price) {
    player.money -= lp.price;
    transferEstateOwnership(game, estate, player.id);
    revealToPlayer(game, player.id, estate.id);
    log(game, `${player.nick} koupil panství ${estate.name} za ${lp.price.toLocaleString('cs-CZ')} £.`);
  } else {
    log(game, `${player.nick} odmítl nákup panství ${estate.name}.`);
  }
  recycleToBottom(game.decks.lord, lp.lordType);
  game.pendingLordPurchase = null;
  return {};
}

// ---------------------------------------------------------------------------
// Discard / debt pending-choice resolution
// ---------------------------------------------------------------------------

function resolveDiscard(game, playerId, cardIds) {
  const pending = game.pendingDiscard[playerId];
  if (!pending) return { error: 'NO_PENDING_DISCARD' };
  const player = getPlayer(game, playerId);
  const ids = (cardIds || []).slice(0, pending.need);
  for (const c of ids) {
    const idx = player.hand.indexOf(c);
    if (idx >= 0) {
      player.hand.splice(idx, 1);
      game.decks.actionDiscard.push(c);
    }
  }
  while (player.hand.length > game.config.handLimit) {
    game.decks.actionDiscard.push(player.hand.pop());
  }
  delete game.pendingDiscard[playerId];
  return {};
}

function resolveDebt(game, playerId, estateId) {
  const pending = game.pendingDebt[playerId];
  if (!pending) return { error: 'NO_PENDING_DEBT' };
  const chosenId = pending.candidates.includes(estateId) ? estateId : pending.candidates[0];
  const estate = getEstate(game, chosenId);
  if (estate && estate.owner === playerId) {
    transferEstateOwnership(game, estate, null);
    log(game, `${getPlayer(game, playerId).nick} vrátil panství ${estate.name} za dluh.`);
  }
  delete game.pendingDebt[playerId];
  return {};
}

// ---------------------------------------------------------------------------
// Negotiation
// ---------------------------------------------------------------------------

function setNegotiationReady(game, playerId, rng) {
  if (game.phase !== 'NEGOTIATION') return { error: 'NOT_NEGOTIATION' };
  if (!game.readyNegotiation.includes(playerId)) game.readyNegotiation.push(playerId);
  if (game.readyNegotiation.length >= game.players.length) {
    goToTurns(game, rng);
  }
  return {};
}

// ---------------------------------------------------------------------------
// Timer-driven forced progression (called periodically by the Room)
// ---------------------------------------------------------------------------

function tick(game, rng) {
  const t = now();
  if (game.phase === 'NEGOTIATION' && game.deadlines.negotiation && t >= game.deadlines.negotiation) {
    goToTurns(game, rng);
    return true;
  }
  if (game.phase === 'TURNS' && !game.pendingReaction && !game.pendingAuction && !game.pendingLordPurchase &&
      game.deadlines.turn && t >= game.deadlines.turn) {
    // Time's up: remaining actions become "Táhni kartu".
    const player = getPlayer(game, game.activePlayer);
    while (game.actionsLeft > 0) {
      const card = drawFromDeck(game, 'action', 'actionDiscard');
      if (card) player.hand.push(card);
      game.actionsLeft -= 1;
    }
    log(game, `${player.nick}: čas vypršel, zbylé akce = Táhni kartu.`);
    endTurnIfDone(game, rng);
    return true;
  }
  if (game.pendingReaction && t >= game.pendingReaction.deadline) {
    const r = game.pendingReaction;
    if (r.type === 'raid') resolveReaction(game, r.awaiting, 'pass', null, rng);
    else if (r.type === 'hostile_offer') resolveHostileOffer(game, r.awaiting, 'accept');
    else if (r.type === 'kompro') resolveKompro(game, r.awaiting, 'money', null);
    else if (r.type === 'dedicke') resolveDedickeReaction(game, r.awaiting, 'pass');
    if (game.phase === 'TURNS') endTurnIfDone(game, rng);
    return true;
  }
  if (game.pendingAuction && !allBidsIn(game) && t >= game.pendingAuction.deadline) {
    resolveAuctionIfReady(game, rng); // fills in defaults for missing bids
    if (game.phase === 'TURNS') endTurnIfDone(game, rng);
    return true;
  }
  for (const pid of Object.keys(game.pendingDiscard)) {
    const pending = game.pendingDiscard[pid];
    if (t >= pending.deadline) {
      const player = getPlayer(game, pid);
      const rand = rng.shuffle(player.hand.slice()).slice(0, pending.need);
      resolveDiscard(game, pid, rand);
    }
  }
  for (const pid of Object.keys(game.pendingDebt)) {
    const pending = game.pendingDebt[pid];
    if (t >= pending.deadline) {
      resolveDebt(game, pid, rng.pick(pending.candidates));
    }
  }
  if (maybeAdvanceRoundEnd(game, rng)) return true;
  return false;
}

function maybeAdvanceRoundEnd(game, rng) {
  if (game.phase === 'ROUND_END' && allHandLimitsClear(game) && !game.pendingReaction && !game.pendingAuction &&
      Object.keys(game.pendingDebt).length === 0) {
    beginRound(game, rng);
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Offers / trades
// ---------------------------------------------------------------------------

let offerCounter = 1;

function createOffer(game, fromId, payload) {
  const toId = payload.to;
  if (!toId || toId === fromId || !getPlayer(game, toId)) return { error: 'INVALID_RECIPIENT' };
  // "Kdy: ve fázi Vyjednávání, nebo během tahů, pokud je účastníkem hráč na tahu."
  const tradingAllowed = game.phase === 'NEGOTIATION' ||
    (game.phase === 'TURNS' && (fromId === game.activePlayer || toId === game.activePlayer));
  if (!tradingAllowed) return { error: 'TRADING_NOT_ALLOWED_NOW' };
  const openFromSender = game.offers.filter((o) => o.from === fromId && o.status === 'open').length;
  if (openFromSender >= 3) return { error: 'TOO_MANY_OPEN_OFFERS' };
  const offer = {
    id: offerCounter++,
    from: fromId,
    to: payload.to,
    give: sanitizeTradeItems(payload.give),
    want: sanitizeTradeItems(payload.want),
    message: (payload.message || '').slice(0, 140),
    status: 'open',
    deadline: now() + game.config.timers.offerSec * 1000,
  };
  game.offers.push(offer);
  log(game, `${getPlayer(game, fromId).nick} ⇄ ${getPlayer(game, offer.to).nick}: nabídka odeslána.`);
  return { offer };
}

function sanitizeTradeItems(items) {
  items = items || {};
  return {
    money: Math.max(0, Math.round((items.money || 0) / 100000) * 100000),
    cards: Array.isArray(items.cards) ? items.cards : [],
    estates: Array.isArray(items.estates) ? items.estates : [],
    reveal: items.reveal || null,
  };
}

function respondOffer(game, playerId, offerId, action, counter) {
  const offer = game.offers.find((o) => o.id === offerId);
  if (!offer || offer.to !== playerId || offer.status !== 'open') return { error: 'INVALID_OFFER' };
  if (action === 'reject') {
    offer.status = 'rejected';
    log(game, `${getPlayer(game, playerId).nick} odmítl nabídku.`);
    return {};
  }
  if (action === 'counter') {
    offer.status = 'countered';
    const result = createOffer(game, playerId, { to: offer.from, give: counter.give, want: counter.want, message: counter.message });
    return result;
  }
  // accept
  const a = getPlayer(game, offer.from);
  const b = getPlayer(game, offer.to);
  if (!validateItems(game, a, offer.give) || !validateItems(game, b, offer.want)) {
    return { error: 'TRADE_NO_LONGER_VALID' };
  }
  transferItems(game, a, b, offer.give);
  transferItems(game, b, a, offer.want);
  offer.status = 'accepted';
  log(game, `${a.nick} ⇄ ${b.nick}: obchod uzavřen.`);
  return {};
}

function validateItems(game, player, items) {
  if (player.money < items.money) return false;
  for (const c of items.cards) if (!player.hand.includes(c)) return false;
  for (const eId of items.estates) {
    const e = getEstate(game, eId);
    if (!e || e.owner !== player.id) return false;
  }
  if (items.reveal != null && !getEstate(game, items.reveal)) return false;
  return true;
}

function transferItems(game, from, to, items) {
  from.money -= items.money;
  to.money += items.money;
  for (const c of items.cards) {
    const idx = from.hand.indexOf(c);
    if (idx >= 0) {
      from.hand.splice(idx, 1);
      to.hand.push(c);
    }
  }
  for (const eId of items.estates) {
    const e = getEstate(game, eId);
    if (e && e.owner === from.id) transferEstateOwnership(game, e, to.id);
  }
  if (items.reveal != null) {
    revealToPlayer(game, to.id, items.reveal);
  }
}

// ---------------------------------------------------------------------------
// Main dispatcher
// ---------------------------------------------------------------------------

function applyAction(game, playerId, action, rng) {
  const player = getPlayer(game, playerId);
  if (!player) return { error: 'UNKNOWN_PLAYER' };

  switch (action.type) {
    case 'negotiation_ready':
      return setNegotiationReady(game, playerId, rng);

    case 'turn_action': {
      const err = requireActivePlayer(game, playerId);
      if (err) return { error: err };
      const handler = turnActions[action.subtype];
      if (!handler) return { error: 'UNKNOWN_ACTION' };
      const result = handler(game, player, action.payload || {}, rng);
      if (!result.error) endTurnIfDone(game, rng);
      return result;
    }

    case 'confirm_lord_purchase': {
      const result = confirmLordPurchase(game, playerId, !!action.payload.accept);
      if (!result.error) endTurnIfDone(game, rng);
      return result;
    }

    case 'reaction_choice': {
      const r = game.pendingReaction;
      if (!r) return { error: 'NO_PENDING_REACTION' };
      let result;
      if (r.type === 'raid') result = resolveReaction(game, playerId, action.payload.choice, action.payload, rng);
      else if (r.type === 'hostile_offer') result = resolveHostileOffer(game, playerId, action.payload.choice);
      else if (r.type === 'kompro') result = resolveKompro(game, playerId, action.payload.choice, action.payload);
      else if (r.type === 'dedicke') result = resolveDedickeReaction(game, playerId, action.payload.choice);
      else result = { error: 'UNKNOWN_REACTION_TYPE' };
      if (!result.error && game.phase === 'TURNS') endTurnIfDone(game, rng);
      return result;
    }

    case 'auction_bid': {
      const result = submitBid(game, playerId, action.payload.amount);
      if (!result.error) resolveAuctionIfReady(game, rng);
      return result;
    }

    case 'resolve_discard': {
      const result = resolveDiscard(game, playerId, action.payload.cardIds);
      maybeAdvanceRoundEnd(game, rng);
      return result;
    }

    case 'resolve_debt': {
      const result = resolveDebt(game, playerId, action.payload.estateId);
      maybeAdvanceRoundEnd(game, rng);
      return result;
    }

    case 'offer_create':
      return createOffer(game, playerId, action.payload);

    case 'offer_respond':
      return respondOffer(game, playerId, action.payload.offerId, action.payload.action, action.payload.counter);

    default:
      return { error: 'UNKNOWN_ACTION_TYPE' };
  }
}

module.exports = {
  newGame,
  startGame,
  applyAction,
  tick,
  getPlayer,
  getEstate,
};
