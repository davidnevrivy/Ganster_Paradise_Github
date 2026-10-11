'use strict';
/*
 * Deterministic seeded RNG (mulberry32) + helpers. Every random decision in
 * the game (shuffles, random estate assignment, turn order, random lord
 * draws...) must go through a game's RNG instance so that a given seed +
 * the same sequence of player inputs always reproduces the same game
 * (acceptance criterion: "Stejný seed a vstupy = stejný výsledek").
 */

function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

class Rng {
  constructor(seed) {
    this.seed = seed >>> 0;
    this._next = mulberry32(this.seed);
  }

  // float in [0,1)
  float() {
    return this._next();
  }

  // integer in [0, n)
  int(n) {
    return Math.floor(this._next() * n);
  }

  // pick & remove a random element from array (mutates), returns element
  draw(array) {
    if (array.length === 0) return undefined;
    const i = this.int(array.length);
    return array.splice(i, 1)[0];
  }

  // pick a random element without removing
  pick(array) {
    return array[this.int(array.length)];
  }

  // Fisher-Yates shuffle, returns new array, deterministic given rng state
  shuffle(array) {
    const a = array.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = this.int(i + 1);
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }
}

function makeSeed() {
  // Non-deterministic only at the point of room creation; the resulting
  // integer seed is what gets stored & reused for replay/debugging.
  return (Date.now() ^ Math.floor(Math.random() * 0xffffffff)) >>> 0;
}

module.exports = { Rng, makeSeed };
