// Puzzle factory. Two properties have to hold for every board that leaves this file, and they are
// checked in this order because the cheap one is the filter:
//
//   1. 零猜测 — the pencil path in js/engine/tapa.js must finish the board on its own (`solve().ok`).
//      A board that only a counter would call unique is refused here, not shipped with a bigger hint
//      budget.
//   2. 唯一解 — implied by (1), because every write the pencil path makes is true in *every* legal
//      colouring, so a board it can finish cannot have a second answer. tools/engine-test.mjs still
//      re-reads each shipped board with js/engine/count.js, an exhaustive walk sharing no code, and
//      the two must agree cell by cell.
//
// The clue set is therefore never "deleted until uniqueness breaks" — that loop cannot even start on
// the many boards whose *full* clue set is already ambiguous. Deleting clues only ever adds colourings
// that satisfy the board, so a full-clue ambiguity is fatal and has to be rejected at the source; what
// trimming then buys is the smallest set that still derives end to end.

import { mix } from './rng.js';
import { BLACK, WHITE, NO_CLUE, clueFrom, cluesFrom, createBoard, isZeroClue, solve } from './tapa.js';

const FOUR = [[-1, 0], [0, 1], [1, 0], [0, -1]];

function shuffled(list, rand) {
  const out = list.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = (rand() * (i + 1)) | 0;
    const t = out[i];
    out[i] = out[j];
    out[j] = t;
  }
  return out;
}

const indices = (n) => Array.from({ length: n }, (_, i) => i);

// ---- the answer we start from -----------------------------------------------
// Blacks are laid down one cell at a time, in random order, and a cell is only taken when the board
// stays legal without it: no 2×2 may close, and the white region may not fall apart. Both tests are
// local to the cell being tried, which is what makes a legal answer cheap to grow — and both are
// monotone (a chosen cell never goes back to white), so whatever holds at each step still holds at
// the end: the whites are one piece and no 2×2 is black.
export function randomInk(w, h, rand, fill = 0.42) {
  const n = w * h;
  const cells = new Int8Array(n); // all WHITE
  const isBlack = (i) => cells[i] === BLACK;
  const wouldClose2x2 = (i) => {
    const r = (i / w) | 0;
    const c = i % w;
    for (let dr = -1; dr <= 0; dr++) {
      for (let dc = -1; dc <= 0; dc++) {
        const rr = r + dr;
        const cc = c + dc;
        if (rr < 0 || cc < 0 || rr + 1 >= h || cc + 1 >= w) continue;
        const q = [rr * w + cc, rr * w + cc + 1, (rr + 1) * w + cc, (rr + 1) * w + cc + 1];
        let hits = 0;
        for (const x of q) if (x === i || isBlack(x)) hits++;
        if (hits === 4) return true;
      }
    }
    return false;
  };
  // i goes black: do the white cells around i still reach each other without it?
  const cutsWhite = (i) => {
    const r = (i / w) | 0;
    const c = i % w;
    const seeds = [];
    for (const [dr, dc] of FOUR) {
      const rr = r + dr;
      const cc = c + dc;
      if (rr < 0 || cc < 0 || rr >= h || cc >= w) continue;
      const nb = rr * w + cc;
      if (cells[nb] === WHITE) seeds.push(nb);
    }
    if (seeds.length < 2) return false;
    const seen = new Set([seeds[0]]);
    const stack = [seeds[0]];
    while (stack.length) {
      const x = stack.pop();
      const xr = (x / w) | 0;
      const xc = x % w;
      for (const [dr, dc] of FOUR) {
        const rr = xr + dr;
        const cc = xc + dc;
        if (rr < 0 || cc < 0 || rr >= h || cc >= w) continue;
        const nb = rr * w + cc;
        if (nb === i || cells[nb] !== WHITE || seen.has(nb)) continue;
        seen.add(nb);
        stack.push(nb);
      }
    }
    return seeds.some((s) => !seen.has(s));
  };
  let blacks = 0;
  for (const i of shuffled(indices(n), rand)) {
    if (rand() > fill) continue;
    if (wouldClose2x2(i) || cutsWhite(i)) continue;
    cells[i] = BLACK;
    blacks++;
  }
  return { cells, blacks };
}

// A black cell is either cluable or it is a hole in the puzzle: `0 0 0` is reserved for white cells,
// and a ring with four runs needs four digits Tapa clues do not have. Either way nothing on the board
// would ever mention that cell, so its colour stays free and the board is ambiguous no matter how
// many clues remain — which is why sample answers are rejected here rather than trimmed later.
export function inkQuality(w, h, cells) {
  let holes = 0;
  let zeroCells = 0;
  for (let i = 0; i < w * h; i++) {
    const code = clueFrom(w, h, cells, i);
    if (cells[i] === BLACK) {
      if (code === null || code === 0) holes++;
    } else if (code === 0) zeroCells++;
  }
  return { holes, zeroCells };
}

// ---- trimming the clue set --------------------------------------------------
// Start from every clue the answer can carry, then delete in random order for as long as the pencil
// path still finishes the board. A deletion that breaks derivability early can become safe once a
// later clue has gone, so the pass repeats until one whole pass changes nothing.
export function pruneClues(w, h, cells, rand, { useNishio = true, passes = 3, keep = null } = {}) {
  const clue = Array.from(cluesFrom(w, h, cells));
  const guarded = keep ? new Set(keep) : new Set();
  for (let p = 0; p < passes; p++) {
    let changed = 0;
    const order = shuffled(
      indices(clue.length).filter((i) => clue[i] !== NO_CLUE && !guarded.has(i)),
      rand
    );
    for (const i of order) {
      if (isZeroClue(clue[i]) && countZero(clue) <= guardedSize(guarded, clue)) continue;
      const saved = clue[i];
      clue[i] = NO_CLUE;
      if (solve(createBoard(w, h, clue), { useNishio }).ok) changed++;
      else clue[i] = saved;
    }
    if (!changed) break;
  }
  return clue;
}

const countZero = (clue) => clue.reduce((k, v) => (v === 0 ? k + 1 : k), 0);
// How many `0 0 0` clues the guarded set alone already guarantees; the trimmer may never take the
// board below that.
const guardedSize = (guarded, clue) => {
  let k = 0;
  for (const i of guarded) if (isZeroClue(clue[i])) k++;
  return Math.max(1, k);
};

// ---- the ladder -------------------------------------------------------------
// Five tiers, chosen by board size × how much of the board is black (which sets how many clues the
// answer can carry). The score bands are *measured* output: `SAMPLES=24 npm run balance` prints the
// quantile table these numbers were read from, and the ladder gate in that same file goes red if a
// fresh sample falls out of them. A tier that silently became easier is the failure mode this family
// has hit before, so the numbers below are data, not ambition — see tools/balance.mjs.
export const TIERS = [
  { name: '入门', size: [5, 5], fill: 0.3, useNishio: false, band: [0, 0], zero: true },
  { name: '简单', size: [6, 6], fill: 0.33, useNishio: false, band: [0, 0], zero: true },
  { name: '中等', size: [7, 7], fill: 0.36, useNishio: true, band: [0, 0], zero: true },
  { name: '困难', size: [9, 9], fill: 0.38, useNishio: true, band: [0, 0], zero: true },
  { name: '大师', size: [11, 11], fill: 0.4, useNishio: true, band: [0, 0], zero: true },
];

export const tierIndexFor = (i) => Math.min(TIERS.length - 1, Math.max(0, i | 0));

// One puzzle: an answer, a trimmed clue set, and the derivation the player will be walked through.
// `tries` bounds the search so a bad seed fails loudly instead of hanging a build step.
export function generate(seed, tier = 0, { tries = 300, rand = mix(seed), onAttempt = null } = {}) {
  const t = TIERS[tierIndexFor(tier)];
  const [w, h] = t.size;
  for (let k = 0; k < tries; k++) {
    const { cells } = randomInk(w, h, rand, t.fill);
    const q = inkQuality(w, h, cells);
    if (q.holes) {
      if (onAttempt) onAttempt({ k, reject: '有无解的黑格', holes: q.holes });
      continue;
    }
    if (t.zero && !q.zeroCells) {
      if (onAttempt) onAttempt({ k, reject: '没有 0 0 0 格' });
      continue;
    }
    const keep = t.zero ? firstZero(w, h, cells) : [];
    const clue = pruneClues(w, h, cells, rand, { useNishio: t.useNishio, keep });
    const board = createBoard(w, h, clue);
    const res = solve(board, { useNishio: t.useNishio });
    if (!res.ok) {
      if (onAttempt) onAttempt({ k, reject: '铅笔路推不完', clues: board.clues, undetermined: res.undetermined });
      continue;
    }
    if (!Array.from(cells).every((v, i) => v === res.derived[i])) {
      if (onAttempt) onAttempt({ k, reject: '推出的答案不是原答案', clues: board.clues });
      continue;
    }
    return {
      seed,
      tier: tierIndexFor(tier),
      w,
      h,
      clue: Array.from(clue),
      solution: Array.from(cells),
      board,
      score: res.score,
      steps: res.steps,
      rounds: res.rounds,
      elim: res.elim,
      breakdown: res.breakdown,
      nishio: res.nishio,
      clues: board.clues,
      density: board.clues / (w * h),
      zeroClues: board.zeroClues,
      attempts: k + 1,
    };
  }
  return null;
}

// The `0 0 0` clue is the one the whole board design hangs on (it is the only clue a careless encoder
// confuses with "no clue"), so at least one of them is guarded through trimming by construction rather
// than by luck — and the guard is only honest because the board is re-solved with it in place.
function firstZero(w, h, cells) {
  for (let i = 0; i < w * h; i++) {
    if (cells[i] === WHITE && clueFrom(w, h, cells, i) === 0) return [i];
  }
  return [];
}

// A board in the shape the save file and the baked library carry.
export function makePuzzle(seed, tier = 0, opts = {}) {
  const g = generate(seed, tier, opts);
  if (!g) return null;
  return {
    seed: typeof seed === 'number' ? seed : String(seed),
    tier: g.tier,
    w: g.w,
    h: g.h,
    clue: g.clue,
    solution: g.solution,
    score: g.score,
    steps: g.steps,
    rounds: g.rounds,
    elim: g.elim,
    clues: g.clues,
    zeroClues: g.zeroClues,
    nishio: g.nishio,
    breakdown: g.breakdown,
  };
}

export const describePuzzle = (p) =>
  `${p.w}×${p.h} · ${p.clues} 条线索 · 难度分 ${p.score} · 推导 ${p.steps} 步${p.nishio ? `（含反证 ${p.nishio} 步）` : ''}`;
