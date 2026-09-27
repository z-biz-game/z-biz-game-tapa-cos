// Second opinion: exhaustive counting. Nothing in this file imports from js/engine/tapa.js, and that
// is the whole point — the pencil solver proves a board is *derivable*, this one proves it is
// *true*, by walking every legal colouring of the grid and looking at what stayed constant across
// them. Two ways to be wrong are much better than one: the sharing here is the puzzle description
// (w, h, the encoded clue triple), never the reasoning.
//
// Deliberately independent choices, so a misunderstanding of the rules cannot be made twice in the
// same shape:
//   * the neighbour list is rebuilt here from the prose (its own clockwise table, its own bounds
//     test) instead of the solver's precomputed ring table;
//   * a ring's runs are read as a plain boolean list, and rotation equivalence uses string
//     containment instead of the solver's index loop;
//   * the search is a row-major exhaustive backtrace with no inference rules at all — it never
//     "deduces" a cell, it tries both colours and keeps whatever survives.
//
// Cost: exponential, pruned only by locally decidable facts. That is fine because it is only ever
// asked about a *finished* puzzle (a few thousand boards in tools/balance.mjs, one board per hint
// audit), never about the thousands of half-deleted candidates the generator throws away.

const UNDECIDED = -1;
const BLANK = -1; // "no clue here", same wire format as the engine, re-derived rather than imported

// ---- geometry, rebuilt -------------------------------------------------------

// Clockwise from north, in-bound only. Written out as its own table on purpose: if the solver's ring
// order and this one ever disagree, the two agree on nothing and the cross-check goes red.
const OFFSETS = [[-1, 0], [-1, 1], [0, 1], [1, 1], [1, 0], [1, -1], [0, -1], [-1, -1]];

function neighboursOf(w, h, i) {
  const r = Math.floor(i / w);
  const c = i % w;
  const out = [];
  for (const [dr, dc] of OFFSETS) {
    const rr = r + dr;
    const cc = c + dc;
    if (rr < 0 || cc < 0 || rr >= h || cc >= w) continue;
    out.push(rr * w + cc);
  }
  return out;
}

// The three numbers of a clue, trailing zeros included as written on the wire.
function digitsOf(code) {
  if (code === BLANK) return null;
  return [Math.floor(code / 100), Math.floor(code / 10) % 10, code % 10];
}

// The positive run lengths a ring shows, as a list. The eight neighbours of an interior cell form a
// cycle, so a run that starts at north and ends at north-west is one run; the moment any neighbour
// is off-board the cycle is broken and the list reads as a path.
function runsOf(flags, cyclic) {
  const runs = [];
  let cur = 0;
  for (const f of flags) {
    if (f) cur++;
    else if (cur) {
      runs.push(cur);
      cur = 0;
    }
  }
  if (cur) runs.push(cur);
  if (cyclic && runs.length > 1 && flags[0] && flags[flags.length - 1]) {
    runs[0] += runs.pop();
  }
  return runs;
}

// Exact, ordered comparison. The clue's numbers are given **in ring order clockwise from north**, so
// the position of a group inside the clue is part of the clue: `2 1` and `1 2` describe different
// rings. This file deliberately re-derives that reading as a plain element-by-element loop rather
// than importing the solver's `sameRuns` — same rule, no shared code, and if either side ever reads
// the clue up to rotation the cross-check goes red on a real board within a few dozen samples.
function sameRuns(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

// ---- the exhaustive walk -----------------------------------------------------

// Cell order: row-major, left to right, top to bottom. Chosen for predictability rather than speed —
// the point of this file is that nobody has to reason about its search order to trust a count.
//
// Pruning is limited to what is decidable from the cells assigned so far, all of it re-derived from
// the rules text: a clue cell's own colour, a completed 2×2, and a clue whose ring is now fully
// assigned. White connectivity is checked only at the leaves, because a half-filled board is allowed
// to look temporarily cut off.
export function analyze(shape, { limit = 2, maxNodes = 400000 } = {}) {
  const w = shape.w;
  const h = shape.h;
  const clue = shape.clue;
  const n = w * h;
  const nbs = [];
  const digitList = [];
  const wantsBlack = [];
  for (let i = 0; i < n; i++) {
    nbs.push(neighboursOf(w, h, i));
    const d = digitsOf(clue[i]);
    digitList.push(d);
    // Rule 2: a clued cell is black, except the all-zero clue, which means "ring and self white".
    wantsBlack.push(d === null ? null : !(d[0] === 0 && d[1] === 0 && d[2] === 0));
    if (d) {
      const sum = d[0] + d[1] + d[2];
      if (sum > nbs[i].length) return { code: 'invalid', reason: `第${Math.floor(i / w) + 1}行${(i % w) + 1}列的线索超过环长`, solutions: [], forced: null, count: 0, nodes: 0 };
    }
  }
  // For each cell, the clues whose ring it belongs to — so assigning one cell knows which clues to
  // re-read. Built here rather than taken from the solver's table.
  const ringOf = [];
  for (let i = 0; i < n; i++) ringOf.push([]);
  for (let i = 0; i < n; i++) if (digitList[i]) for (const c of nbs[i]) ringOf[c].push(i);
  // The 2×2 blocks a cell closes as its bottom-right corner.
  const blocks = [];
  for (let i = 0; i < n; i++) {
    const r = Math.floor(i / w);
    const c = i % w;
    if (r === 0 || c === 0) {
      blocks.push(null);
      continue;
    }
    blocks.push([i - w - 1, i - w, i - 1, i]);
  }

  const value = Array.from({ length: n }, () => UNDECIDED);
  const solutions = [];
  let count = 0;
  let nodes = 0;
  let stop = false;
  // `exhaustive` means the walk covered the whole tree: it is false both when the node budget cut in
  // and when the search stopped early because `limit` answers were already in hand. Only an
  // exhaustive walk may claim `none` or `unique`, and only an exhaustive walk's answer set may be
  // intersected into `forced` — five solutions that all black a cell prove nothing about a sixth.
  let exhaustive = true;
  let budget = false;

  function clueReady(i) {
    const ring = nbs[i];
    for (const c of ring) if (value[c] === UNDECIDED) return false;
    const flags = ring.map((c) => value[c] === 1);
    return sameRuns(runsOf(flags, ring.length === 8), digitList[i].filter((d) => d > 0));
  }

  function okAfterAssign(i) {
    const want = wantsBlack[i];
    if (want !== null && (value[i] === 1) !== want) return false;
    const b = blocks[i];
    if (b && value[b[0]] === 1 && value[b[1]] === 1 && value[b[2]] === 1 && value[b[3]] === 1) return false;
    // Every clue that lost its last undecided ring cell must read correctly now, and no clue may
    // already show more blacks than it asks for.
    for (const cl of ringOf[i]) {
      let sum = 0;
      let open = 0;
      for (const c of nbs[cl]) {
        if (value[c] === UNDECIDED) open++;
        else if (value[c] === 1) sum++;
      }
      const d = digitList[cl];
      if (sum > d[0] + d[1] + d[2]) return false;
      if (!open && !clueReady(cl)) return false;
    }
    return true;
  }

  function whitesLinked() {
    let total = 0;
    for (let i = 0; i < n; i++) if (value[i] === 0) total++;
    if (total <= 1) return total === 1;
    const seen = Array.from({ length: n }, () => 0);
    const stack = [];
    for (let i = 0; i < n; i++) {
      if (value[i] !== 0 || seen[i]) continue;
      seen[i] = 1;
      stack.push(i);
      let reached = 1;
      while (stack.length) {
        const c = stack.pop();
        const r = Math.floor(c / w);
        const cc = c % w;
        for (const [dr, dc] of [[-1, 0], [0, 1], [1, 0], [0, -1]]) {
          const rr = r + dr;
          const ccc = cc + dc;
          if (rr < 0 || ccc < 0 || rr >= h || ccc >= w) continue;
          const nb = rr * w + ccc;
          if (value[nb] !== 0 || seen[nb]) continue;
          seen[nb] = 1;
          reached++;
          stack.push(nb);
        }
      }
      if (reached !== total) return false;
    }
    return true;
  }

  function walk(i) {
    if (stop) return;
    if (nodes > maxNodes) {
      exhaustive = false;
      budget = true;
      stop = true;
      return;
    }
    if (i === n) {
      if (!whitesLinked()) return;
      count++;
      if (solutions.length < limit) solutions.push(value.slice());
      if (count >= limit) {
        exhaustive = false;
        stop = true;
      }
      return;
    }
    for (const v of [1, 0]) {
      if (stop) return;
      nodes++;
      value[i] = v;
      if (okAfterAssign(i)) walk(i + 1);
      value[i] = UNDECIDED;
    }
  }

  walk(0);

  // The cell-by-cell verdict the cross-check compares against: 0/1 where every solution agrees,
  // UNDECIDED where they differ. Computed only from an exhaustive walk — a truncated one has not seen
  // enough answers to rule a cell decided, so it hands back an all-unknown list and the caller says
  // "this board proves nothing" instead of reading a coincidence as a theorem.
  const forced = Array.from({ length: n }, () => UNDECIDED);
  if (exhaustive && solutions.length) {
    for (let i = 0; i < n; i++) {
      const first = solutions[0][i];
      let same = true;
      for (const s of solutions) if (s[i] !== first) same = false;
      if (same) forced[i] = first;
    }
  }
  const code = budget ? 'budget' : !count ? 'none' : count === 1 ? 'unique' : 'many';
  return { code, count: exhaustive ? count : `${count}+`, forced, solutions, nodes, exhaustive };
}

// The question the generator asks: does this clue set have exactly one solution? `limit` is 2, so the
// walk is allowed to stop the moment a second colouring shows up.
export function isUnique(shape, opts = {}) {
  const r = analyze(shape, { limit: 2, ...opts });
  return { unique: r.code === 'unique', ...r };
}

// Every colouring of the grid the rules accept, up to `limit`. Used by the test suite to pin small
// boards down completely (a 3×3 with one clue has a countable number of answers).
export function listSolutions(shape, limit = 32, opts = {}) {
  const r = analyze(shape, { limit, ...opts });
  return r.solutions;
}
