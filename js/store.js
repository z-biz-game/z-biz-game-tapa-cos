// Persistence. Everything lives under one key so a reset is one line, and a run in progress is
// stored as (origin seed, tier, the ink written so far, what the run has cost) rather than a copy of
// the clue set or the solution — the generator is deterministic, so the board never has to travel
// through storage, and a finished 11×11 comes to a couple of hundred bytes.
//
// The whole file has to survive a hostile environment: Safari in private mode throws from the
// *getter* of `localStorage`, not just from `setItem`, and a save written by an older build is
// indistinguishable from corruption. So every access is guarded and every read is shape-checked —
// a save that cannot be understood is discarded, never half-trusted.

import { BLACK, WHITE, UNKNOWN } from './engine/tapa.js';

const KEY = 'tapa.save.v1';

const defaults = () => ({
  settings: { sound: true, reduceMotion: false },
  best: {},
  resume: null,
  totals: { solved: 0, hints: 0, ms: 0 },
});

// Cell states are UNKNOWN/BLACK/WHITE on the engine side, and a board in progress is mostly UNKNOWN
// — run-length coding is why a 121-cell save is not a 3 KB JSON array. The engine's UNKNOWN is 2, so
// the wire re-maps it to 0: an untouched board then encodes as a single run, which is the whole
// reason the mapping exists rather than storing the engine's numbers directly.
function toWire(v) {
  return v === UNKNOWN ? 0 : v === BLACK ? 1 : 2;
}

function fromWire(v) {
  return v === 0 ? UNKNOWN : v === 1 ? BLACK : WHITE;
}

function rleEncode(board) {
  const out = [];
  if (!board.length) return out;
  let run = toWire(board[0]);
  let n = 1;
  for (let i = 1; i < board.length; i++) {
    const v = toWire(board[i]);
    if (v === run && n < 255) n++;
    else {
      out.push(run, n);
      run = v;
      n = 1;
    }
  }
  out.push(run, n);
  return out;
}

function rleDecode(pairs, len) {
  const b = new Int8Array(len);
  let i = 0;
  for (let p = 0; p + 1 < pairs.length; p += 2) {
    const v = pairs[p];
    const n = pairs[p + 1];
    if (!(v === 0 || v === 1 || v === 2) || !(n >= 1) || !(n <= 255)) continue; // junk run: skip it
    for (let k = 0; k < n && i < len; k++) b[i++] = fromWire(v);
  }
  while (i < len) b[i++] = 2; // a truncated save resumes as unknown, never as a shifted board
  return b;
}

// One guarded read: `localStorage` itself can throw on property access in some privacy modes.
function readRaw() {
  try {
    const store = globalThis.localStorage;
    if (!store) return null;
    return store.getItem(KEY);
  } catch {
    return null;
  }
}

function writeRaw(text) {
  try {
    const store = globalThis.localStorage;
    if (!store) return false;
    store.setItem(KEY, text);
    return true;
  } catch {
    // private mode / quota — the game is still playable, just forgetful
    return false;
  }
}

const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

// A save is *shape-checked*, not just parsed: a resume whose cell count disagrees with its own board
// size is dropped rather than fed to a Game that would paint a shifted board and call it the same
// puzzle. This is the one place two readers could disagree.
function sanitize(parsed) {
  const base = defaults();
  if (!isObj(parsed)) return base;
  const out = {
    settings: { ...base.settings, ...(isObj(parsed.settings) ? parsed.settings : {}) },
    best: {},
    resume: null,
    totals: { ...base.totals, ...(isObj(parsed.totals) ? parsed.totals : {}) },
  };
  out.settings.sound = !!out.settings.sound;
  out.settings.reduceMotion = !!out.settings.reduceMotion;
  if (isObj(parsed.best)) {
    for (const [tier, r] of Object.entries(parsed.best)) {
      if (isObj(r) && isNum(r.ms) && isNum(r.hints) && isNum(r.moves) && r.ms >= 0) out.best[tier] = r;
    }
  }
  for (const k of ['solved', 'hints', 'ms']) if (!isNum(out.totals[k]) || out.totals[k] < 0) out.totals[k] = 0;
  const r = parsed.resume;
  if (isObj(r) && isNum(r.cells) && r.cells > 0 && r.cells <= 4096 && Array.isArray(r.ink) && isNum(r.tier)) {
    out.resume = {
      seed: typeof r.seed === 'string' ? r.seed : isNum(r.seed) ? r.seed : null,
      tier: Math.max(0, r.tier | 0),
      elapsedMs: isNum(r.elapsedMs) && r.elapsedMs >= 0 ? r.elapsedMs : 0,
      cells: r.cells | 0,
      ink: r.ink.filter((v) => Number.isInteger(v)),
      moves: isNum(r.moves) ? r.moves : 0,
      hints: isNum(r.hints) ? r.hints : 0,
      at: isNum(r.at) ? r.at : 0,
    };
  }
  return out;
}

function load() {
  const raw = readRaw();
  if (!raw) return defaults();
  try {
    return sanitize(JSON.parse(raw));
  } catch {
    return defaults();
  }
}

export const Store = {
  data: load(),

  save() {
    writeRaw(JSON.stringify(this.data));
  },

  setting(name) {
    return this.data.settings[name];
  },
  setSetting(name, value) {
    this.data.settings[name] = value;
    this.save();
  },

  best(tier) {
    return this.data.best[tier] || null;
  },
  // Best time is decided by *least help taken* first: a record must mean "I worked this board out
  // myself", and a fast run built on six hints is not that.
  recordBest(tier, { ms, hints, moves, size }) {
    const cur = this.data.best[tier];
    const better =
      !cur || hints < cur.hints || (hints === cur.hints && (moves < cur.moves || (moves === cur.moves && ms < cur.ms)));
    if (better) this.data.best[tier] = { ms, hints, moves, size, at: Date.now() };
    this.save();
    return better;
  },

  recordSolve(ms, hints) {
    const t = this.data.totals;
    t.solved++;
    t.hints += hints;
    t.ms += ms;
    this.save();
  },

  saveResume(puzzle, state, elapsedMs, run) {
    this.data.resume = {
      // The generator derives its internal stream from what it is handed, so a resume has to store
      // the *origin* seed or the rebuilt board would not be the same one.
      seed: puzzle.originSeed ?? puzzle.seed,
      tier: puzzle.tier,
      elapsedMs,
      cells: puzzle.w * puzzle.h,
      ink: rleEncode(state),
      // The cost of the run travels with the board. Without it a player could take six hints, close
      // the tab, come back, and finish with a clean 提示 0 record — the number that decides the best
      // time is counted from actions, and actions are not saved.
      moves: run.moves,
      hints: run.hints,
      at: Date.now(),
    };
    this.save();
  },

  resume() {
    const r = this.data.resume;
    if (!r) return null;
    return { ...r, board: rleDecode(r.ink, r.cells) };
  },

  // The board a resume claims to be has to be the board the caller is holding. A save from a 9-cell
  // puzzle replayed onto a 16-cell one would paint every cell after the ninth as 未知 and call the
  // result the same run — losing the run is the honest failure, a shifted board is not.
  resumeBoard(n) {
    const r = this.data.resume;
    if (!r || r.cells !== n) return null;
    return rleDecode(r.ink, r.cells);
  },

  clearResume() {
    this.data.resume = null;
    this.save();
  },

  // A real reset: memory and storage both go, so a reload cannot find the run again. Writing the
  // defaults back would put the key on disk again for no reason — an absent key *is* the empty state.
  reset() {
    this.data = defaults();
    try {
      globalThis.localStorage?.removeItem(KEY);
    } catch {
      /* nothing to un-do: it was never written */
    }
  },

  // Exposed for the assertions on save shape — the harness checks the round-trip without a browser.
  _rle: { encode: rleEncode, decode: rleDecode, toWire, fromWire },
  _key: KEY,
};
