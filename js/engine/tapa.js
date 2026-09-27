// 视窗 · Tapa engine. The board is a grid of black/white cells; a clue cell carries three numbers
// saying how the black cells are grouped around it, and the two board-wide constraints
// (every white cell in one 4-connected piece, no 2×2 all black) do the rest.
//
// Everything the solver knows comes from one fact: a clue on an interior cell has only 2^8 = 256
// ways to colour its ring, so "what do the clues allow here?" is a finite set the engine can
// *enumerate and intersect* instead of guessing. Every write below is a consequence of a set the
// clues really do leave standing, which is what makes this one function usable as (a) the player's
// route, (b) the generator's acceptance test and (c) the source of every hint — and it never
// backtracks. Search lives only in js/engine/count.js, and the two share no ring table and no rule
// (that is the point of the second opinion — see DESIGN §4).

export const WHITE = 0;
export const BLACK = 1;
// UNKNOWN is 2, not 0. A run of whites already means "0 black cells", so 0 was taken by a legal
// value the moment `0 0 0` became a clue; spending it on "undecided" is how a board starts
// answering questions nobody asked.
export const UNKNOWN = 2;

// "No clue here" is -1 in the encoded triple, never 0 — `0 0 0` encodes to 0 and is a real, strong
// clue. DESIGN §2 is the post-mortem, and both test suites carry the assertion that keeps it from
// coming back.
export const NO_CLUE = -1;

// Clockwise from north. This order *is* the definition of "按环序": it fixes which groups the three
// numbers describe, and the renderer's 北/东北/… labels index the same table.
export const RING_ORDER = [
  [-1, 0, '北'],
  [-1, 1, '东北'],
  [0, 1, '东'],
  [1, 1, '东南'],
  [1, 0, '南'],
  [1, -1, '西南'],
  [0, -1, '西'],
  [-1, -1, '西北'],
];

const FOUR = [
  [-1, 0],
  [0, 1],
  [1, 0],
  [0, -1],
];

export const cellName = (w, i) => `第${(((i / w) | 0) + 1)}行${(i % w) + 1}列`;
export const stateName = (v) => (v === BLACK ? '黑' : v === WHITE ? '白' : '未知');
export const opposite = (v) => (v === BLACK ? WHITE : v === WHITE ? BLACK : UNKNOWN);
const decided = (v) => v !== UNKNOWN;

// ---- the clue triple ---------------------------------------------------------
// One Int16 per cell: a*100 + b*10 + c for the padded triple (a b c); -1 means "no clue".
// Nikoli omits *trailing* zeros, so `3` is (3,0,0) and `3 1` is (3,1,0) — while (0,0,0) encodes to
// 0, a value that must never be read as the sentinel.

export function encodeClue(a, b = 0, c = 0) {
  if (!(a >= 0 && a <= 8 && b >= 0 && b <= 8 && c >= 0 && c <= 8)) throw new Error('线索数字超出 0..8');
  return a * 100 + b * 10 + c;
}

export function decodeClue(code) {
  if (code === NO_CLUE) return null;
  return [(code / 100) | 0, ((code / 10) | 0) % 10, code % 10];
}

export const clueSum = (code) => {
  const d = decodeClue(code);
  return d[0] + d[1] + d[2];
};

export const isZeroClue = (code) => code === 0;

// What gets drawn and spoken: `3 1` shows two digits, `0 0 0` shows three zeros, an unclued cell
// shows nothing. Those last two are exactly what a "0 means empty" encoding cannot tell apart, so
// the decision is written down once, here.
export function clueDigits(code) {
  if (code === NO_CLUE) return [];
  const d = decodeClue(code);
  if (d[0] === 0 && d[1] === 0 && d[2] === 0) return [0, 0, 0];
  while (d.length > 1 && d[d.length - 1] === 0) d.pop();
  return d;
}

export const describeClue = (code) => (code === NO_CLUE ? '（无线索）' : clueDigits(code).join(' '));

// The non-zero entries of a clue: the run lengths its ring must show, in ring order.
export const clueRuns = (code) => decodeClue(code).filter((v) => v > 0);

// ---- ring geometry -----------------------------------------------------------

// In-bound ring slots, clockwise from north. Off-board positions are *absent*, which is what turns
// an edge clue into a row of slots rather than a ring — see ringRuns().
export function ringCells(w, h, i) {
  const r = (i / w) | 0;
  const c = i % w;
  const out = [];
  for (const [dr, dc] of RING_ORDER) {
    const rr = r + dr;
    const cc = c + dc;
    if (rr < 0 || cc < 0 || rr >= h || cc >= w) continue;
    out.push(rr * w + cc);
  }
  return Int32Array.from(out);
}

// The compass direction of slot s of clue cell i — the s-th *existing* neighbour, so labels skip the
// off-board directions instead of indexing RING_ORDER directly.
export function ringLabel(w, h, i, s) {
  const r = (i / w) | 0;
  const c = i % w;
  let k = 0;
  for (let d = 0; d < RING_ORDER.length; d++) {
    const rr = r + RING_ORDER[d][0];
    const cc = c + RING_ORDER[d][1];
    if (rr < 0 || cc < 0 || rr >= h || cc >= w) continue;
    if (k === s) return RING_ORDER[d][2];
    k++;
  }
  return RING_ORDER[RING_ORDER.length - 1][2];
}

// Which slot of clue cell `clue`'s ring holds cell i (-1 when it is not on that ring).
export function slotOf(board, clue, i) {
  const ring = board.rings[clue];
  for (let s = 0; s < ring.length; s++) if (ring[s] === i) return s;
  return -1;
}

// Black runs read off a bitmask over the ring, in ring order.
//
// An 8-slot ring is a *cycle*: slot 0 (north) and slot 7 (north-west) touch, so a mask holding both
// is one run of two, not two runs of one. Fewer than 8 slots means the clue sits on an edge or in a
// corner, and the off-board directions are always one contiguous arc of the ring (top removes 7,0,1;
// right removes 1,2,3; …), so what is left is a path and the ends do **not** join.
//
// Getting this wrong is quiet and fatal: treat the interior as a path and a `2` clued cell reads its
// own ring as `1 1`; treat an edge as a cycle and a corner with three black neighbours reads `1 1 1`
// where the rules say `3`. DESIGN §3 carries both assertions.
export function ringRuns(mask, slots) {
  const out = [];
  let run = 0;
  for (let s = 0; s < slots; s++) {
    if (mask & (1 << s)) run++;
    else if (run) {
      out.push(run);
      run = 0;
    }
  }
  if (run) out.push(run);
  // out.length > 1 keeps the full circle (mask 0xff, one run of 8) from being added to itself.
  if (slots === 8 && out.length > 1 && (mask & 1) && mask & (1 << 7)) {
    out[0] += out[out.length - 1];
    out.pop();
  }
  return out;
}

// The clue lists its groups in the order they appear scanning clockwise **from north**, so the order
// of the numbers is part of the clue: a ring black at 北东北东 and 南 reads `2 1`, and the same ring
// turned a quarter-step reads `1 2`. Comparing run lists up to rotation would be a weaker reading —
// every clue would accept more rings, the solver would see more possibilities and write fewer cells.
// It is still sound (a superset of the truth forces only what the truth forces) but it is not the
// rules this repo claims to implement, so the comparison is exact and `ringRuns` anchors at north.
export function sameRuns(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

const bitCount = (m) => {
  let k = 0;
  for (; m; m >>= 1) k += m & 1;
  return k;
};

// Every way to colour this ring so its run lengths are the clue's numbers. `null` for an unclued
// cell — an empty list there would mean "impossible", not "don't care".
//
// Memoised across boards, because the generator rebuilds a board for every trial deletion and the
// (code, slots) pairs repeat heavily. Callers must treat the returned array as read-only: solve()
// copies it into its own live list before shrinking (see DESIGN §7 for the cost this saves).
const PATTERN_CACHE = new Map();

export function ringPatterns(code, slots) {
  if (code === NO_CLUE) return null;
  const key = code * 16 + slots;
  const hit = PATTERN_CACHE.get(key);
  if (hit) return hit;
  const want = clueRuns(code);
  const blacks = want.reduce((x, y) => x + y, 0);
  const out = [];
  const total = 1 << slots;
  for (let mask = 0; mask < total; mask++) {
    if (!want.length) {
      if (mask === 0) out.push(0);
      continue;
    }
    if (bitCount(mask) !== blacks) continue;
    if (sameRuns(ringRuns(mask, slots), want)) out.push(mask);
  }
  PATTERN_CACHE.set(key, out);
  return out;
}

// ---- board ------------------------------------------------------------------

export function createBoard(w, h, clue) {
  if (!(w >= 3 && h >= 3)) throw new Error('盘至少 3×3');
  const n = w * h;
  if (!clue || clue.length !== n) throw new Error('clue length mismatch');
  const rings = [];
  for (let i = 0; i < n; i++) rings.push(ringCells(w, h, i));
  const clued = [];
  for (let i = 0; i < n; i++) if (clue[i] !== NO_CLUE) clued.push(i);
  if (!clued.length) throw new Error('盘上没有线索');
  for (const i of clued) {
    for (const v of decodeClue(clue[i])) if (v < 0 || v > 8) throw new Error(`${cellName(w, i)} 的线索不合法`);
    const sum = clueSum(clue[i]);
    if (sum > rings[i].length) {
      throw new Error(
        `${cellName(w, i)} 写着 ${describeClue(clue[i])}，需要 ${sum} 个黑格，可它环上只有 ${rings[i].length} 格`
      );
    }
  }
  const patterns = Array.from({ length: n }, () => null);
  for (const i of clued) patterns[i] = ringPatterns(clue[i], rings[i].length);
  const quads = [];
  for (let r = 0; r + 1 < h; r++) for (let c = 0; c + 1 < w; c++) {
    quads.push(Int32Array.from([r * w + c, r * w + c + 1, (r + 1) * w + c, (r + 1) * w + c + 1]));
  }
  // Which clues' rings a cell sits in. The pencil path re-runs ringStep only for clues a write
  // actually touched, and this is the table that makes "touched" answerable in O(8).
  const byCell = Array.from({ length: n }, () => []);
  for (const i of clued) for (const c of rings[i]) byCell[c].push(i);
  let zeroClues = 0;
  let patternTotal = 0;
  for (const i of clued) {
    if (isZeroClue(clue[i])) zeroClues++;
    patternTotal += patterns[i].length;
  }
  return {
    w,
    h,
    n,
    clue: Int16Array.from(clue),
    rings,
    patterns,
    quads,
    byCell,
    clued,
    clues: clued.length,
    zeroClues,
    patternTotal,
    cells: Array.from({ length: n }, (_, i) => i),
    name: (i) => cellName(w, i),
    digits: (i) => clueDigits(clue[i]),
    ringOf: (i) => rings[i],
    slotOf: (clueCell, i) => slotOf({ rings }, clueCell, i),
    label: (clueCell, s) => ringLabel(w, h, clueCell, s),
    isClue: (i) => clue[i] !== NO_CLUE,
  };
}

// Runs straight off a cell array: same cyclic rule as ringRuns, applied to the ring of cell i.
export function ringRunsFromCells(w, h, cells, i) {
  const ring = ringCells(w, h, i);
  const runs = [];
  let run = 0;
  for (const c of ring) {
    if (cells[c] === BLACK) run++;
    else if (run) {
      runs.push(run);
      run = 0;
    }
  }
  if (run) runs.push(run);
  if (ring.length === 8 && runs.length > 1 && cells[ring[0]] === BLACK && cells[ring[7]] === BLACK) {
    runs[0] += runs[runs.length - 1];
    runs.pop();
  }
  return runs;
}

// The clue a solved board implies at cell i. A clue cell is black itself, so it is never part of
// its own ring — that is rule 2, and it is why the same black shape reads differently depending on
// whether the numbered cell sits inside it.
export function clueFrom(w, h, cells, i) {
  const runs = ringRunsFromCells(w, h, cells, i);
  if (runs.length > 3) return null;
  return encodeClue(runs[0] || 0, runs[1] || 0, runs[2] || 0);
}

// The full clue set of a solution: every cell that *can* carry a clue does. Three kinds of cell stay
// blank, and each for its own reason: a white cell with black neighbours has nothing to say (only
// `0 0 0` is legal on a white cell); a ring showing four black runs needs four digits, which Tapa
// clues do not have; and a lone black cell surrounded by white would have to be clued `0 0 0`, which
// rule 2 forbids — `0 0 0` marks a *white* cell. A board is not obliged to say everything it knows.
export function cluesFrom(w, h, cells) {
  const out = new Int16Array(w * h).fill(NO_CLUE);
  for (let i = 0; i < out.length; i++) {
    const code = clueFrom(w, h, cells, i);
    if (code === null) continue;
    if (cells[i] === BLACK) {
      if (code !== 0) out[i] = code;
    } else if (code === 0) out[i] = 0;
  }
  return out;
}

// ---- rules ------------------------------------------------------------------
// Weights are the difficulty currency: score = Σ weight × writes + ELIM_WEIGHT × Σ (the share of a
// clue's patterns that a ring write threw out). tools/balance.mjs reads the ladder off those same
// numbers, so a new rule here moves the measured bands — a rule can never be quietly free.
export const Rules = {
  selfBlack: { key: 'selfBlack', name: '线索自黑', weight: 1 },
  ring: { key: 'ring', name: '环上相容', weight: 1 },
  no2x2: { key: 'no2x2', name: '二乘二禁', weight: 1.6 },
  link: { key: 'link', name: '白格连通', weight: 2.2 },
  nishio: { key: 'nishio', name: '反证排除', weight: 3 },
};

// Credit for *shrinking the possibility set* rather than just counting one. Two boards with the
// same step count differ here, and that gap is what a player feels as "这一格要想很久"; balance.mjs
// prints the elim column on its own so the contribution stays auditable.
export const ELIM_WEIGHT = 1.5;

// The four cheap passes share one context: the working state, the per-clue live pattern lists, and
// the dirty set that says which clues could have changed since the last round.
function makeApi(rows) {
  return { rows, wrote: 0, push(row) { rows.push(row); this.wrote++; } };
}

function put(ctx, cell, value, row) {
  ctx.state[cell] = value;
  ctx.out.push(row);
  // Whatever ring contains this cell may now conclude something it could not conclude before.
  for (const cl of ctx.board.byCell[cell]) ctx.dirty[cl] = 1;
}

// ---- 1. the clue cell's own colour ------------------------------------------

function selfPass(ctx) {
  const { board, state } = ctx;
  for (const i of board.clued) {
    const want = isZeroClue(board.clue[i]) ? WHITE : BLACK;
    if (decided(state[i])) {
      if (state[i] !== want) {
        return `${cellName(board.w, i)} 写着 ${describeClue(board.clue[i])}，线索格自己必须是${stateName(want)}格，可这里是${stateName(state[i])}`;
      }
      continue;
    }
    put(ctx, i, want, {
      cell: i,
      value: want,
      rule: Rules.selfBlack,
      clue: i,
      slot: -1,
      kind: want === BLACK ? 'self' : 'self-white',
      left: board.patterns[i].length,
      total: board.patterns[i].length,
      elim: 0,
      why: isZeroClue(board.clue[i])
        ? `${cellName(board.w, i)} 写着 0 0 0：它八邻全是白格，它自己也必须是白格`
        : `${cellName(board.w, i)} 带着线索 ${describeClue(board.clue[i])}，带线索的格子自己就是黑格`,
    });
  }
  return null;
}

// ---- 2. enumerate the ring, then intersect it -------------------------------
// Keeps only the patterns compatible with what is already known, then writes what every survivor
// agrees on. `live` is threaded through the whole derivation and only ever shrinks, so a pattern
// discarded at round 1 cannot come back to "help" at round 4 (DESIGN §4).
function ringStep(ctx, clueCell, live) {
  const { board, state } = ctx;
  const ring = board.rings[clueCell];
  const k = ring.length;
  const survivors = [];
  for (const mask of live) {
    let ok = true;
    for (let s = 0; s < k; s++) {
      const st = state[ring[s]];
      if (st === BLACK && !(mask & (1 << s))) {
        ok = false;
        break;
      }
      if (st === WHITE && mask & (1 << s)) {
        ok = false;
        break;
      }
    }
    if (ok) survivors.push(mask);
  }
  const total = board.patterns[clueCell].length;
  if (!survivors.length) {
    return `${cellName(board.w, clueCell)} 写着 ${describeClue(board.clue[clueCell])}，已经没有相容的摆法`;
  }
  live.length = 0;
  for (const m of survivors) live.push(m);
  const hits = new Int32Array(k);
  for (const mask of survivors) for (let s = 0; s < k; s++) if (mask & (1 << s)) hits[s]++;
  const share = 1 - survivors.length / total;
  for (let s = 0; s < k; s++) {
    const cell = ring[s];
    if (decided(state[cell])) continue;
    let value = -1;
    let kind = '';
    if (hits[s] === survivors.length) {
      value = BLACK;
      kind = 'forced';
    } else if (hits[s] === 0) {
      value = WHITE;
      kind = 'banned';
    }
    if (value < 0) continue;
    put(ctx, cell, value, {
      cell,
      value,
      rule: Rules.ring,
      clue: clueCell,
      slot: s,
      kind,
      left: survivors.length,
      total,
      elim: share,
      why: ringWhy(board, clueCell, s, value, survivors.length, total, kind),
    });
  }
  return null;
}

function ringWhy(board, clueCell, slot, value, left, total, kind) {
  const where = cellName(board.w, clueCell);
  const target = cellName(board.w, board.rings[clueCell][slot]);
  const clue = describeClue(board.clue[clueCell]);
  if (left === 1) {
    return `${where} 的 ${clue} 只剩 1 种摆法（原来有 ${total} 种）：${board.label(clueCell, slot)}方向那一格是${stateName(value)}`;
  }
  if (kind === 'forced') {
    return `${where} 的 ${clue} 还剩 ${left} 种摆法（原来有 ${total} 种），每一种都把 ${target} 染成黑`;
  }
  return `${where} 的 ${clue} 还剩 ${left} 种摆法（原来有 ${total} 种），没有一种把 ${target} 染成黑，所以 ${target} 是白格`;
}

// ---- 3. no 2×2 all black ----------------------------------------------------

function no2x2Pass(ctx) {
  const { board, state } = ctx;
  for (const q of board.quads) {
    let blacks = 0;
    let unknown = -1;
    let unknowns = 0;
    for (const c of q) {
      const v = state[c];
      if (v === BLACK) blacks++;
      else if (v === UNKNOWN) {
        unknown = c;
        unknowns++;
      }
    }
    if (blacks === 4) return `${cellName(board.w, q[0])} 一带的 2×2 已经全黑`;
    if (blacks !== 3 || unknowns !== 1) continue;
    put(ctx, unknown, WHITE, {
      cell: unknown,
      value: WHITE,
      rule: Rules.no2x2,
      clue: -1,
      slot: -1,
      kind: 'block',
      left: 0,
      total: 0,
      elim: 0,
      quad: q,
      why: `2×2 不能全黑：${cellName(board.w, q[0])}、${cellName(board.w, q[1])}、${cellName(board.w, q[2])}、${cellName(board.w, q[3])} 里已有三格是黑，剩下的 ${cellName(board.w, unknown)} 只能是白格`,
    });
  }
  return null;
}

// ---- 4. the white region stays in one piece ---------------------------------
//   * a pocket of still-undecided cells cut off from every decided white can never hold a white,
//     so it goes all black;
//   * an undecided cell whose going black would split the white region in two (real whites on both
//     sides) can never go black, so it stays white.
// Both read the graph of "cells that could still be white" — decided whites ∪ unknowns.
function whiteComponents(board, state) {
  const { w, h, n } = board;
  const comp = new Int32Array(n).fill(-1);
  const cells = [];
  const whites = [];
  let id = 0;
  for (let i = 0; i < n; i++) {
    if (state[i] === BLACK || comp[i] >= 0) continue;
    const stack = [i];
    const list = [];
    let known = 0;
    comp[i] = id;
    while (stack.length) {
      const c = stack.pop();
      list.push(c);
      if (state[c] === WHITE) known++;
      const r = (c / w) | 0;
      const cc = c % w;
      for (const [dr, dc] of FOUR) {
        const rr = r + dr;
        const ccc = cc + dc;
        if (rr < 0 || ccc < 0 || rr >= h || ccc >= w) continue;
        const nb = rr * w + ccc;
        if (state[nb] === BLACK || comp[nb] >= 0) continue;
        comp[nb] = id;
        stack.push(nb);
      }
    }
    cells.push(list);
    whites.push(known);
    id++;
  }
  return { cells, whites };
}

function linkPass(ctx) {
  const { board, state } = ctx;
  const { cells, whites } = whiteComponents(board, state);
  const nc = cells.length;
  if (!nc) return null;
  let withWhite = 0;
  for (const k of whites) if (k > 0) withWhite++;
  if (withWhite >= 2) {
    return `白格被黑格切成了 ${withWhite} 块，可规则要求所有白格连成一整块`;
  }
  if (nc >= 2 && withWhite === 1) {
    for (let id = 0; id < nc; id++) {
      if (whites[id] > 0) continue;
      for (const c of cells[id]) {
        if (state[c] !== UNKNOWN) continue;
        put(ctx, c, BLACK, {
          cell: c,
          value: BLACK,
          rule: Rules.link,
          clue: -1,
          slot: -1,
          kind: 'pocket',
          left: 0,
          total: 0,
          elim: 0,
          why: `白格必须连成一整块：${cellName(board.w, c)} 所在的一片已经被黑格围死、跟已落的白格不再相通，所以这一片只能是黑`,
        });
      }
    }
    return null;
  }
  // Articulation points. One DFS per component answers "if this cell went black, would white fall
  // off?" for every cell at once, which is what makes the rule cheap enough to run every round.
  let totalWhites = 0;
  for (const c of board.cells) if (state[c] === WHITE) totalWhites++;
  if (totalWhites < 2) return null;
  const { w, h, n } = board;
  const disc = new Int32Array(n).fill(-1);
  const low = new Int32Array(n);
  const sub = new Int32Array(n); // decided whites inside this DFS subtree
  const timer = { t: 0 };
  const cuts = [];
  const around = (c) => {
    const r = (c / w) | 0;
    const cc = c % w;
    const list = [];
    for (const [dr, dc] of FOUR) {
      const rr = r + dr;
      const ccc = cc + dc;
      if (rr < 0 || ccc < 0 || rr >= h || ccc >= w) continue;
      const nb = rr * w + ccc;
      if (state[nb] !== BLACK) list.push(nb);
    }
    return list;
  };
  const dfs = (u, parent, compId) => {
    disc[u] = low[u] = timer.t++;
    sub[u] = state[u] === WHITE ? 1 : 0;
    let pieces = 0;
    for (const v of around(u)) {
      if (v === parent) continue;
      if (disc[v] >= 0) {
        low[u] = Math.min(low[u], disc[v]);
        continue;
      }
      dfs(v, u, compId);
      low[u] = Math.min(low[u], low[v]);
      sub[u] += sub[v];
      // A child subtree that cannot reach above u becomes its own piece when u goes black.
      if (low[v] >= disc[u] && sub[v] > 0) pieces++;
    }
    // The "everything else" piece, i.e. the side that stays attached to the parent.
    const rest = whites[compId] - sub[u] > 0 ? 1 : 0;
    if (state[u] === UNKNOWN && pieces + rest >= 2) cuts.push(u);
  };
  for (let id = 0; id < nc; id++) {
    const root = cells[id][0];
    if (disc[root] >= 0) continue;
    dfs(root, -1, id);
  }
  // Written after the DFS so a conclusion cannot change the graph mid-walk.
  for (const u of cuts) {
    if (state[u] !== UNKNOWN) continue;
    put(ctx, u, WHITE, {
      cell: u,
      value: WHITE,
      rule: Rules.link,
      clue: -1,
      slot: -1,
      kind: 'cut',
      left: 0,
      total: 0,
      elim: 0,
      why: `${cellName(board.w, u)} 一旦变黑就把白格切成两半（两边都已经有落好的白格），可所有白格必须连成一片——所以它是白格`,
    });
  }
  return null;
}

// ---- 5. 反证 (nishio) --------------------------------------------------------
// "Suppose this cell were black: the clues would have no compatible filling — so it is white", and
// the mirror. A proof, not a guess, and the rule that carries a Tapa board once one-clue-at-a-time
// intersections run dry: an edge clue whose ring is too short to pin a cell alone still pins it
// once you follow what the *other* clues allow.
//
// Kept out of the inner loop on purpose — the cheap passes reach their own fixed point first, so a
// board's nishio count is a difficulty reading rather than an artefact of the search order.
function nishioPass(ctx, live, { depth = 6 } = {}) {
  const { board, state, out } = ctx;
  const scratch = new Int8Array(board.n);
  for (const i of board.cells) {
    if (state[i] !== UNKNOWN) continue;
    for (const assume of [BLACK, WHITE]) {
      scratch.set(state);
      scratch[i] = assume;
      // Only the rings containing `i` can react to the assumption, and everything else is already
      // at its fixed point — seeding the probe's dirty set with those is what keeps 反证 affordable
      // enough to run on every stalled board.
      const dirty = new Uint8Array(board.n);
      for (const cl of board.byCell[i]) dirty[cl] = 1;
      const probe = { board, state: scratch, dirty, out: makeApi([]), live: copyLive(live, board.n) };
      const r = sweep(probe, depth);
      if (!r.conflict) continue;
      const value = assume === BLACK ? WHITE : BLACK;
      put(ctx, i, value, {
        cell: i,
        value,
        rule: Rules.nishio,
        clue: -1,
        slot: -1,
        kind: 'nishio',
        assume,
        left: 0,
        total: 0,
        elim: 0,
        why: `反证：假设 ${cellName(board.w, i)} 是${stateName(assume)}，就会撞上「${r.conflict}」——所以这一格只能是${stateName(value)}`,
      });
      break;
    }
  }
  return null;
}

// ---- the pencil path ---------------------------------------------------------

// The cheap passes, run to a fixed point. Order does not change the fixed point (each pass only
// ever writes what its own justification forces), but it decides which rule a hint gets to cite
// first, so the local rules run before the expensive global ones.
// `live` is indexed by *cell*, not by position in board.clued: ringStep is called for one dirty
// clue at a time and an indexOf per call costs O(clues²) per round, which the generator pays on
// every trial deletion.
function sweep(ctx, maxRounds = 200) {
  const { board, dirty, out } = ctx;
  let rounds = 0;
  for (; rounds < maxRounds; rounds++) {
    const before = out.wrote;
    let conflict = selfPass(ctx);
    if (!conflict) {
      for (const cl of board.clued) {
        if (!dirty[cl]) continue;
        dirty[cl] = 0;
        conflict = ringStep(ctx, cl, ctx.live[cl]);
        if (conflict) break;
      }
    }
    if (!conflict) conflict = no2x2Pass(ctx);
    if (!conflict) conflict = linkPass(ctx);
    if (conflict) return { conflict, rounds: rounds + 1, wrote: out.wrote };
    if (out.wrote === before) break;
  }
  return { conflict: null, rounds, wrote: out.wrote };
}

export const freshState = (board) => new Int8Array(board.n).fill(UNKNOWN);

const countUnknown = (state) => {
  let k = 0;
  for (const v of state) if (v === UNKNOWN) k++;
  return k;
};

function copyLive(live, n) {
  const out = Array.from({ length: n }, () => null);
  for (let i = 0; i < n; i++) if (live[i]) out[i] = live[i].slice();
  return out;
}

function makeCtx(board, state, { allDirty = true } = {}) {
  const rows = [];
  const dirty = new Uint8Array(board.n);
  if (allDirty) for (const cl of board.clued) dirty[cl] = 1;
  const live = Array.from({ length: board.n }, () => null);
  for (const i of board.clued) live[i] = board.patterns[i].slice();
  return { board, state, dirty, live, out: makeApi(rows), rows };
}

// Derive from an empty board. The returned rows are the deductions in the order the clues forced
// them — that list *is* the hint script, and it never reads the player's ink, so a wrong cell
// cannot make the hints agree with the mistake.
//
// `ok` means "the pencil path alone finished this board". When it is false the board is not broken,
// it is *refused*: the generator may not ship it. That is the whole content of 零猜测.
//
// `steps` cannot be a difficulty reading on its own: every cell is written exactly once, so a 5×5 is
// always 25 steps and an 11×11 always 121. What varies is *which* rule got each cell and how many
// waves the board needed — `rounds` counts the propagation waves, `score` weighs the rules, `elim`
// counts the possibility space each ring write threw out. tools/balance.mjs reads those three.
export function solve(board, { useNishio = true, nishioDepth = 6, maxNishioRounds = 300 } = {}) {
  const ctx = makeCtx(board, freshState(board));
  let r = sweep(ctx);
  let rounds = r.rounds;
  let nishioRounds = 0;
  while (!r.conflict && useNishio && countUnknown(ctx.state) > 0 && nishioRounds < maxNishioRounds) {
    const before = ctx.out.wrote;
    nishioPass(ctx, ctx.live, { depth: nishioDepth });
    nishioRounds++;
    if (ctx.out.wrote === before) break;
    // A 反证 write is an ordinary decided cell now: let the cheap passes harvest what it unlocks.
    for (const cl of board.clued) ctx.dirty[cl] = 1;
    r = sweep(ctx);
    rounds += r.rounds;
  }
  const conflict = r.conflict || null;
  const undetermined = countUnknown(ctx.state);
  let score = 0;
  let elim = 0;
  const breakdown = {};
  let deepest = 0;
  for (const row of ctx.rows) {
    breakdown[row.rule.name] = (breakdown[row.rule.name] || 0) + 1;
    score += row.rule.weight + ELIM_WEIGHT * (row.elim || 0);
    elim += row.elim || 0;
    deepest = Math.max(deepest, row.rule.weight);
  }
  return {
    ok: !conflict && undetermined === 0,
    derived: ctx.state,
    rows: ctx.rows,
    steps: ctx.rows.length,
    rounds,
    conflict,
    score: Math.round(score * 10) / 10,
    elim: Math.round(elim * 100) / 100,
    breakdown,
    deepest,
    undetermined,
    nishio: breakdown[Rules.nishio.name] || 0,
    nishioRounds,
  };
}

// The next single thing the clues force that `state` does not already know. Same code path as the
// acceptance sweep, which is what makes "the hints are always right" and "this board needs no
// guessing" one property instead of two.
export function nextDeduction(board, state) {
  const ctx = makeCtx(board, Int8Array.from(state));
  const r = sweep(ctx);
  if (r.conflict) return { conflict: r.conflict };
  if (ctx.rows.length) return ctx.rows[0];
  nishioPass(ctx, ctx.live);
  if (ctx.rows.length) return ctx.rows[0];
  return null;
}

// ---- is this ink still survivable? ------------------------------------------
// Every write the cheap passes make holds in *every* solution, so if seeding the player's own cells
// and then running those passes hits a contradiction, no completion of this board exists. That is
// the one thing a player cannot see coming — a single wrong cell breaks no visible count — and it
// is worth saying out loud (DESIGN §6). Cheap passes only: no 反证, so this can miss dead ends but
// never invent one.
export function reachable(board, cells) {
  const ctx = makeCtx(board, Int8Array.from(cells));
  const r = sweep(ctx, board.n + 2);
  return !r.conflict;
}

// ---- readouts for the UI ----------------------------------------------------

// Judged straight from the rules of the game: three numbers around each clue cell, no 2×2 black,
// the whites in one piece. Nothing here reads the derivation or the hint script, so a bug in the
// propagation cannot fake a win. Cells still UNKNOWN are neither praised nor blamed — this answers
// "is what the player has written wrong?", not "is the board finished?".
export function verify(board, cells) {
  const bad = [];
  for (const i of board.clued) {
    const want = isZeroClue(board.clue[i]) ? WHITE : BLACK;
    if (cells[i] !== UNKNOWN && cells[i] !== want) {
      bad.push({ kind: 'clue', clue: i, cell: i, why: `${cellName(board.w, i)} 带着线索，它自己必须是${stateName(want)}格` });
    }
    let open = 0;
    let blacks = 0;
    for (const c of board.rings[i]) {
      if (cells[c] === UNKNOWN) open++;
      else if (cells[c] === BLACK) blacks++;
    }
    const sum = clueSum(board.clue[i]);
    if (blacks > sum) {
      bad.push({ kind: 'clue', clue: i, cell: i, why: `${cellName(board.w, i)} 的 ${describeClue(board.clue[i])} 只要 ${sum} 个黑格，环上已经有 ${blacks} 个` });
    } else if (!open) {
      const runs = ringRunsFromCells(board.w, board.h, cells, i);
      if (!sameRuns(runs, clueRuns(board.clue[i]))) {
        bad.push({
          kind: 'clue',
          clue: i,
          cell: i,
          why: `${cellName(board.w, i)} 写着 ${describeClue(board.clue[i])}，可环上的黑格实际是 ${runs.length ? runs.join(' ') : '一段也没有'}`,
        });
      }
    }
  }
  for (const q of board.quads) {
    let all = true;
    for (const c of q) if (cells[c] !== BLACK) all = false;
    if (all) bad.push({ kind: 'block', quad: q, cell: q[0], why: `${cellName(board.w, q[0])} 一带的 2×2 全黑了` });
  }
  for (const p of linkProblems(board, cells)) bad.push(p);
  return bad;
}

// White connectivity: for a finished board "all whites in one piece", and for a board in progress
// "two decided whites that can never meet again" — which is a problem before the last cell lands.
export function linkProblems(board, cells) {
  const { cells: comps, whites } = whiteComponents(board, cells);
  let known = 0;
  for (const c of board.cells) if (cells[c] === WHITE) known++;
  if (!known) return [];
  const pieces = [];
  for (let id = 0; id < comps.length; id++) if (whites[id] > 0) pieces.push(comps[id]);
  return pieces.slice(1).map((p) => ({
    kind: 'link',
    cells: p,
    cell: p[0],
    why: `白格分成了互不相通的一片（${cellName(board.w, p[0])} 一带），可所有白格必须连成一整块`,
  }));
}

export function complete(board, cells) {
  for (const v of cells) if (v === UNKNOWN) return false;
  return verify(board, cells).length === 0;
}

export function diagnose(board, cells) {
  let blacks = 0;
  let whites = 0;
  let unknowns = 0;
  for (const v of cells) {
    if (v === BLACK) blacks++;
    else if (v === WHITE) whites++;
    else unknowns++;
  }
  const violated = new Set();
  const satisfied = new Set();
  for (const i of board.clued) {
    let open = 0;
    let blk = 0;
    for (const c of board.rings[i]) {
      if (cells[c] === UNKNOWN) open++;
      else if (cells[c] === BLACK) blk++;
    }
    const wantSelf = isZeroClue(board.clue[i]) ? WHITE : BLACK;
    const sum = clueSum(board.clue[i]);
    if ((cells[i] !== UNKNOWN && cells[i] !== wantSelf) || blk > sum) {
      violated.add(i);
      continue;
    }
    if (open || cells[i] === UNKNOWN) continue;
    const runs = ringRunsFromCells(board.w, board.h, cells, i);
    if (sameRuns(runs, clueRuns(board.clue[i]))) satisfied.add(i);
    else violated.add(i);
  }
  const blocks = new Set();
  const linkCells = new Set();
  for (const p of verify(board, cells)) {
    if (p.kind === 'block') for (const c of p.quad) blocks.add(c);
    else if (p.kind === 'clue') violated.add(p.clue);
    else if (p.kind === 'link') for (const c of p.cells) linkCells.add(c);
  }
  return {
    blacks,
    whites,
    unknowns,
    remaining: unknowns,
    total: board.n,
    clues: board.clues,
    violated,
    satisfied,
    blocks,
    linkCells,
    problems: verify(board, cells),
    conflicts: violated.size + blocks.size + linkCells.size,
    stuck: !reachable(board, cells),
  };
}

// ---- the player's own ink ---------------------------------------------------

export function createState(board) {
  return { board, cell: new Int8Array(board.n).fill(UNKNOWN), history: [] };
}

export function snapshot(st) {
  st.history.push(Int8Array.from(st.cell));
  if (st.history.length > 600) st.history.shift();
  return st;
}

export function undo(st) {
  const last = st.history.pop();
  if (!last) return false;
  st.cell.set(last);
  return true;
}

export function setCell(st, t, value) {
  if (t < 0 || t >= st.board.n) return false;
  if (st.cell[t] === value) return false;
  snapshot(st);
  st.cell[t] = value;
  return true;
}

// The tap cycle the game asks for: 未知 → 黑 → 白 → 未知.
export function nextValue(v) {
  return v === UNKNOWN ? BLACK : v === BLACK ? WHITE : UNKNOWN;
}

// One gesture, one snapshot: the cells a drag covered are written together or not at all.
export function setAll(st, cells, value) {
  const writes = [];
  const seen = new Set();
  for (const t of cells) {
    if (t < 0 || t >= st.board.n || seen.has(t)) continue;
    seen.add(t);
    if (st.cell[t] === value) continue;
    writes.push({ cell: t, from: st.cell[t], to: value });
  }
  if (!writes.length) return null;
  snapshot(st);
  for (const w of writes) st.cell[w.cell] = w.to;
  return writes;
}
