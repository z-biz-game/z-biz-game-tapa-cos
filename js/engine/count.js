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
//
// What "locally decidable" is allowed to mean here, stated exactly, because the walk's whole value is
// that it never *deduces* a cell — it only refuses a branch:
//   1. the colour a clue demands of its own cell;
//   2. a 2×2 that just closed all black;
//   3. a clue whose ring, read with its undecided cells left open, has **no** completion that matches
//      its numbers (`extensible`). Checking only "is the finished ring right?" leaves a branch open
//      until its last ring cell lands, and on an 11×11 with 22 clues that is where the walk used to
//      run out of nodes;
//   4. the whites already painted, which must still be able to reach each other through the cells that
//      are white-or-undecided (`whitesStillLinked`). A half-filled board may look temporarily cut off
//      — it may not be cut off *for good*.
// Each of those four answers the same question for one branch: "can this partial colouring still be
// completed into a legal board?". A branch that answers no is dropped; nothing is ever written to a
// cell that the walk had not already tried both colours of. That is what keeps the count a count, and
// it is checked as such in tools/engine-test.mjs §7b, where the walk's answer for every 3×3 and 4×4
// clue set is compared against the 2^(w·h) colourings listed by a third, independent enumerator.

const UNDECIDED = -1;
const BLANK = -1; // "no clue here", same wire format as the engine, re-derived rather than imported

// ---- geometry, rebuilt -------------------------------------------------------

// Clockwise from north, in-bound only. Written out as its own table on purpose: if the solver's ring
// order and this one ever disagree, the two agree on nothing and the cross-check goes red.
const OFFSETS = [[-1, 0], [-1, 1], [0, 1], [1, 1], [1, 0], [1, -1], [0, -1], [-1, -1]];

// 4-connected, the only adjacency the "all whites in one piece" rule speaks of.
const FOUR = [[-1, 0], [0, 1], [1, 0], [0, -1]];

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

// 3^8, indexed by the ternary reading of a ring (0 white / 1 black / 2 undecided per slot, in ring
// order). Used as the memo key of `extensible` below.
const POW3 = [1, 3, 9, 27, 81, 243, 729, 2187, 6561];

// ---- the exhaustive walk -----------------------------------------------------

// Cell order: row-major, left to right, top to bottom. Chosen for predictability rather than speed —
// the point of this file is that nobody has to reason about its search order to trust a count.
//
// Pruning is the four local tests spelled out at the top of this file, all of them re-derived from the
// rules text and none of them writing a cell: a clue's own colour, a 2×2 that closed, a clue ring that
// has no matching completion left, and whites that have been cut apart for good.
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

  // Every bit pattern this clue's ring may wear, listed once by trying all 2^ring of them through the
  // same `runsOf` this file uses at the leaves. `extensible` then asks "could the undecided slots still
  // be filled in to land on one of these?" — a question about the clue's own ring, answered by
  // enumeration rather than by any rule about how to solve Tapa.
  const accepted = [];
  const ternary = [];
  for (let i = 0; i < n; i++) {
    if (!digitList[i]) {
      accepted.push(null);
      ternary.push(null);
      continue;
    }
    const m = nbs[i].length;
    const want = digitList[i].filter((d) => d > 0);
    const flags = new Array(m);
    const ok = new Uint8Array(1 << m);
    for (let mask = 0; mask < (1 << m); mask++) {
      for (let s = 0; s < m; s++) flags[s] = ((mask >> s) & 1) === 1;
      if (sameRuns(runsOf(flags, m === 8), want)) ok[mask] = 1;
    }
    accepted.push(ok);
    // 0 = not asked yet, 1 = still extensible, 2 = dead. Keyed by the ternary reading of the ring, so
    // the same half-coloured ring seen down a different branch costs one array read.
    ternary.push(new Uint8Array(POW3[m]));
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

  // Is there any way to colour this clue's still-undecided ring cells so the ring reads exactly as the
  // clue says? False means the branch is dead; true means nothing except "not dead yet".
  function extensible(i) {
    const ring = nbs[i];
    const m = ring.length;
    const memo = ternary[i];
    let mask = 0;
    let unknown = 0;
    let key = 0;
    for (let s = 0; s < m; s++) {
      const v = value[ring[s]];
      if (v === 1) mask |= 1 << s;
      if (v === UNDECIDED) unknown |= 1 << s;
      key += (v === UNDECIDED ? 2 : v) * POW3[s];
    }
    const seen = memo[key];
    if (seen) return seen === 1;
    const set = accepted[i];
    let alive = false;
    for (let sub = unknown; ; sub = (sub - 1) & unknown) {
      if (set[mask | sub]) {
        alive = true;
        break;
      }
      if (sub === 0) break;
    }
    memo[key] = alive ? 1 : 2;
    return alive;
  }

  // The painted whites must still be one piece — where a path may run through any cell that is not
  // already black. Checked after every assignment, because painting a cell black is exactly the move
  // that can close the last door between two white halves.
  function whitesStillLinked() {
    let total = 0;
    let start = -1;
    for (let i = 0; i < n; i++) {
      if (value[i] === 0) {
        total++;
        if (start < 0) start = i;
      }
    }
    if (total <= 1) return true;
    const seen = new Uint8Array(n);
    const stack = [start];
    seen[start] = 1;
    let reached = 1;
    while (stack.length) {
      const c = stack.pop();
      const r = Math.floor(c / w);
      const cc = c % w;
      for (const [dr, dc] of FOUR) {
        const rr = r + dr;
        const c2 = cc + dc;
        if (rr < 0 || c2 < 0 || rr >= h || c2 >= w) continue;
        const nb = rr * w + c2;
        if (value[nb] === 1 || seen[nb]) continue;
        seen[nb] = 1;
        if (value[nb] === 0) reached++;
        stack.push(nb);
      }
    }
    return reached === total;
  }

  function okAfterAssign(i) {
    const want = wantsBlack[i];
    if (want !== null && (value[i] === 1) !== want) return false;
    const b = blocks[i];
    if (b && value[b[0]] === 1 && value[b[1]] === 1 && value[b[2]] === 1 && value[b[3]] === 1) return false;
    // No clue may already show more blacks than it asks for, and none may have run out of ways to
    // read correctly. `extensible` covers the finished-ring case on its own (an all-decided ring is
    // looked up in the very table the leaf check uses), so there is one spelling of that rule here.
    for (const cl of ringOf[i]) {
      let sum = 0;
      for (const c of nbs[cl]) if (value[c] === 1) sum++;
      const d = digitList[cl];
      if (sum > d[0] + d[1] + d[2]) return false;
      if (!extensible(cl)) return false;
    }
    if (!whitesStillLinked()) return false;
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
