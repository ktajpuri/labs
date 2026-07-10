// mulberry32 — small, fast, deterministic PRNG so `generate.js` produces
// byte-identical datasets across runs/engines given the same seed.
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const CHARS = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

function randomString(rand, length) {
  let out = "";
  for (let i = 0; i < length; i++) {
    out += CHARS[(rand() * CHARS.length) | 0];
  }
  return out;
}

module.exports = { mulberry32, randomString };
