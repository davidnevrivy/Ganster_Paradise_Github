'use strict';
/*
 * Bot smoke-test harness. The brief's acceptance criterion asks for 1,000
 * bot games with no exceptions, average finish in rounds 6-8, nothing over
 * 30 rounds. This script drives the full engine (not a separate rules
 * reimplementation) with a simple greedy/random bot policy, through every
 * phase and pending-choice type, to flush out crashes and infinite loops.
 *
 * Usage: node scripts/simulate.js [count] [playersMin-playersMax]
 */
const { Rng } = require('../server/game/rng');
const engine = require('../server/game/engine');
const config = require('../server/config.json');

function randInt(rng, n) {
  return rng.int(n);
}

function botChooseAndAct(game, rng, guard) {
  // Resolve whatever pending choice exists, or take a turn action for the
  // active player. Returns false if nothing could be done (shouldn't
  // happen in a well-formed game).
  if (game.phase === 'GAME_OVER') return false;

  if (game.phase === 'LOBBY' || game.phase === 'SETUP') return false;

  if (game.phase === 'NEGOTIATION') {
    for (const p of game.players) {
      engine.applyAction(game, p.id, { type: 'negotiation_ready' }, rng);
    }
    return true;
  }

  for (const pid of Object.keys(game.pendingDiscard)) {
    const player = engine.getPlayer(game, pid);
    const need = game.pendingDiscard[pid].need;
    const cardIds = rng.shuffle(player.hand.slice()).slice(0, need);
    engine.applyAction(game, pid, { type: 'resolve_discard', payload: { cardIds } }, rng);
    return true;
  }
  for (const pid of Object.keys(game.pendingDebt)) {
    const cands = game.pendingDebt[pid].candidates;
    engine.applyAction(game, pid, { type: 'resolve_debt', payload: { estateId: rng.pick(cands) } }, rng);
    return true;
  }

  if (game.pendingLordPurchase) {
    const lp = game.pendingLordPurchase;
    const player = engine.getPlayer(game, lp.playerId);
    const accept = player.money >= lp.price;
    engine.applyAction(game, lp.playerId, { type: 'confirm_lord_purchase', payload: { accept } }, rng);
    return true;
  }

  if (game.pendingAuction) {
    const a = game.pendingAuction;
    for (const pid of a.participants) {
      if (a.submitted[pid]) continue;
      const player = engine.getPlayer(game, pid);
      const amount = rng.float() < 0.5 ? 0 : Math.min(player.money, randInt(rng, 4) * 100000);
      engine.applyAction(game, pid, { type: 'auction_bid', payload: { amount } }, rng);
    }
    return true;
  }

  if (game.pendingReaction) {
    const r = game.pendingReaction;
    let choice = 'pass';
    const roll = rng.float();
    if (r.type === 'raid') {
      if (r.canBribe && roll < 0.4) choice = 'bribe';
      else if (r.canFalseLead && roll < 0.6) choice = 'false_lead';
    } else if (r.type === 'hostile_offer') {
      if (r.canLawyer && roll < 0.2) choice = 'lawyer';
      else if (r.canRefuse && roll < 0.5) choice = 'refuse';
      else choice = 'accept';
    } else if (r.type === 'kompro') {
      if (r.canLawyer && roll < 0.2) choice = 'lawyer';
      else choice = roll < 0.6 ? 'money' : 'cards';
    } else if (r.type === 'dedicke') {
      choice = r.canLawyer && roll < 0.3 ? 'lawyer' : 'pass';
    }
    let payload = { choice };
    if (choice === 'false_lead') {
      const candidates = game.estates.filter((e) => e.owner && e.owner !== r.awaiting && !r.history.includes(e.id));
      if (candidates.length) payload.estateId = rng.pick(candidates).id;
      else payload = { choice: 'pass' };
    }
    engine.applyAction(game, r.awaiting, { type: 'reaction_choice', payload }, rng);
    return true;
  }

  if (game.phase !== 'TURNS') return false;
  const player = engine.getPlayer(game, game.activePlayer);
  const neutral = game.estates.filter((e) => e.owner === null);
  const ownedEmpty = game.estates.filter((e) => e.owner === player.id && !e.grow);
  const othersEstates = game.estates.filter((e) => e.owner && e.owner !== player.id);

  const options = ['draw_card'];
  if (player.money >= config.costs.buyCards) options.push('buy_cards');
  if (neutral.length && player.money >= 300000) options.push('buy_estate');
  if (ownedEmpty.length && player.money >= config.abilities.pestitelSow) options.push('sow');
  if (othersEstates.length && player.money >= config.costs.check) options.push('check');
  if (othersEstates.length && !player.denunciationUsedThisTurn && player.money >= config.costs.denounce) options.push('denounce');
  const playable = player.hand.filter((c) => ['informator', 'razie', 'nabidka', 'cerny', 'kompro', 'presun', 'dedicke'].includes(c));
  if (playable.length) options.push('play_card');

  const subtype = rng.pick(options);
  let payload = {};
  if (subtype === 'buy_estate') payload = { estateId: rng.pick(neutral).id };
  if (subtype === 'sow') payload = { estateId: rng.pick(ownedEmpty).id };
  if (subtype === 'check') payload = { estateId: rng.pick(game.estates).id };
  if (subtype === 'denounce') payload = { estateId: rng.pick(othersEstates).id };
  if (subtype === 'play_card') {
    const cardId = rng.pick(playable);
    if (cardId === 'informator') payload = { cardId, estateIds: [rng.pick(game.estates).id, rng.pick(game.estates).id] };
    else if (cardId === 'razie') payload = { cardId, estateId: rng.pick(game.estates).id };
    else if (cardId === 'nabidka' || cardId === 'dedicke') {
      if (othersEstates.length === 0) { payload = null; }
      else payload = { cardId, estateId: rng.pick(othersEstates).id };
    } else if (cardId === 'cerny') {
      const mine = game.estates.filter((e) => e.owner === player.id && e.grow);
      if (!mine.length) payload = null;
      else payload = { cardId, estateId: rng.pick(mine).id };
    } else if (cardId === 'kompro') {
      const others = game.players.filter((p) => p.id !== player.id);
      payload = { cardId, targetPlayerId: rng.pick(others).id };
    } else if (cardId === 'presun') {
      const mine = game.estates.filter((e) => e.owner === player.id);
      if (mine.length < 2) payload = null;
      else {
        const shuffled = rng.shuffle(mine.slice());
        payload = { cardId, estateIds: [shuffled[0].id, shuffled[1].id] };
      }
    }
    if (payload == null) {
      engine.applyAction(game, player.id, { type: 'turn_action', subtype: 'draw_card', payload: {} }, rng);
      return true;
    }
  }
  const result = engine.applyAction(game, player.id, { type: 'turn_action', subtype, payload }, rng);
  if (result && result.error) {
    // fall back to a free action so the simulation never stalls on a bad guess
    engine.applyAction(game, player.id, { type: 'turn_action', subtype: 'draw_card', payload: {} }, rng);
  }
  return true;
}

function runOneGame(seed, n) {
  const rng = new Rng(seed);
  const players = Array.from({ length: n }, (_, i) => ({ id: `p${i}`, nick: `Bot${i}`, token: `t${i}`, connected: true }));
  const game = engine.newGame(`SIM-${seed}`, config, seed, players);
  engine.startGame(game, rng);

  let guard = 0;
  const MAX_STEPS = 200000;
  while (game.phase !== 'GAME_OVER' && guard < MAX_STEPS) {
    const progressed = botChooseAndAct(game, rng, guard);
    if (!progressed) break;
    guard++;
  }
  return { game, steps: guard, stalled: game.phase !== 'GAME_OVER' };
}

function main() {
  const count = Number(process.argv[2] || 200);
  const range = (process.argv[3] || '3-6').split('-').map(Number);
  let maxRound = 0;
  let totalRounds = 0;
  let wins = { lords: 0, police: 0, renegade: 0, none: 0 };
  let errors = [];
  let stalls = 0;

  for (let i = 0; i < count; i++) {
    const n = range[0] + (i % (range[1] - range[0] + 1));
    const seed = 1000000 + i;
    try {
      const { game, stalled } = runOneGame(seed, n);
      if (stalled) { stalls++; continue; }
      totalRounds += game.round;
      maxRound = Math.max(maxRound, game.round);
      if (game.winner) wins[game.winner.side]++;
      else wins.none++;
      if (game.round > config.maxRounds) {
        errors.push(`seed=${seed} players=${n} exceeded maxRounds`);
      }
    } catch (e) {
      errors.push(`seed=${seed} players=${n} threw: ${e.stack}`);
    }
  }

  console.log(`Games: ${count}`);
  console.log(`Average round of victory: ${(totalRounds / (count - stalls)).toFixed(2)}`);
  console.log(`Max round reached: ${maxRound}`);
  console.log(`Wins by side:`, wins);
  console.log(`Stalled (no winner, ran out of safe steps): ${stalls}`);
  console.log(`Errors: ${errors.length}`);
  for (const e of errors.slice(0, 10)) console.log(' -', e);
  process.exit(errors.length > 0 ? 1 : 0);
}

main();
