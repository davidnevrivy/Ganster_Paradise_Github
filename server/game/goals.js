'use strict';

/**
 * Win-condition check. Only ever called right after the ACTIVE player's
 * turn (GOAL_CHECK step) — per the brief, other players' goals are never
 * checked mid-turn, so there is always exactly one winner, decided at the
 * moment their own turn ends.
 */
function checkGoal(game, playerId) {
  const player = game.players.find((p) => p.id === playerId);
  if (!player) return null;
  const g = game.goals;
  const estateCount = game.estates.filter((e) => e.owner === playerId).length;

  if (player.side === 'lords') {
    if (player.growCount >= g.G && estateCount >= g.E) {
      return { playerId, side: 'lords', character: player.character };
    }
  } else if (player.side === 'police') {
    if (game.investigation >= g.TH && player.growCount >= g.K) {
      return { playerId, side: 'police', character: player.character };
    }
  } else if (player.side === 'renegade') {
    if (estateCount >= g.IE && player.growCount >= g.IG) {
      return { playerId, side: 'renegade', character: player.character };
    }
  }
  return null;
}

function goalProgress(game, playerId) {
  const player = game.players.find((p) => p.id === playerId);
  if (!player) return null;
  const g = game.goals;
  const estateCount = game.estates.filter((e) => e.owner === playerId).length;
  if (player.side === 'lords') {
    return { grows: [player.growCount, g.G], estates: [estateCount, g.E] };
  }
  if (player.side === 'police') {
    return { investigation: [game.investigation, g.TH], grows: [player.growCount, g.K] };
  }
  return { estates: [estateCount, g.IE], grows: [player.growCount, g.IG] };
}

module.exports = { checkGoal, goalProgress };
