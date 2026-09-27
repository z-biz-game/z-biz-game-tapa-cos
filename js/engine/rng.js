// One deterministic string → number, and one deterministic number → stream. Everything that
// decides *which board you get* goes through these two functions: the generator, the daily
// puzzle, the baked campaign and the save file (which stores a seed, never a board).
//
// FNV-1a then xorshift32 rather than a hand-rolled LCG because the second step is what makes
// nearby seeds (`bake#0`, `bake#1`) land on unrelated boards — without it the campaign's first
// three lots share their black skeleton and differ only in which numbers survived.

// String seeds hash to 32 bits; number seeds are taken as-is. `|| 1` because xorshift's only
// fixed point is zero, and a zero state would stream 0.0 forever.
export function hashSeed(input) {
  let x = 2166136261;
  const s = String(input);
  for (let i = 0; i < s.length; i++) {
    x ^= s.charCodeAt(i);
    x = Math.imul(x, 16777619) >>> 0;
  }
  return (x || 1) >>> 0;
}

export function mix(seed) {
  let x = typeof seed === 'number' ? seed >>> 0 : hashSeed(seed);
  x = x || 1;
  return () => {
    x ^= x << 13;
    x >>>= 0;
    x ^= x >> 17;
    x ^= x << 5;
    x >>>= 0;
    return x / 4294967296;
  };
}

// Day key in the local calendar, e.g. `2026-09-27`. The daily puzzle is the same board for
// everyone on the same date, so the key has to be a *date*, not a timestamp.
export function dayKey(now = new Date()) {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export { hashSeed as fnv };
