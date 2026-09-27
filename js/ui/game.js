// The playable state machine: what a tap does, what a drag commits, when a board counts as solved,
// and what a hint is allowed to say.
//
// Two deliberate bindings to js/engine/tapa.js:
//   * the ink lives in the engine's own `st.cell` array and the win check is the engine's independent
//     `verify()` — judged from the rules of the game rather than from this file's bookkeeping — so
//     "the UI said I won" cannot disagree with "every clue adds up, no 2×2 is black, the whites are
//     one piece".
//   * hints are read out of a script the *clues* produced (`solve()`), never out of the player's own
//     marks. A wrong cell therefore cannot make the hints agree with the mistake: the engine keeps
//     saying what the numbers actually force, and refuses to write over a contradiction.

import {
  BLACK,
  WHITE,
  UNKNOWN,
  Rules,
  createState,
  diagnose,
  nextValue,
  reachable,
  setAll,
  setCell,
  solve,
  undo as undoState,
  verify,
  complete,
} from '../engine/tapa.js';

export { BLACK, WHITE, UNKNOWN };

export const valueName = (v) => (v === BLACK ? '黑' : v === WHITE ? '白' : '未知');

export class Game {
  constructor(puzzle) {
    this.puzzle = puzzle;
    this.board = puzzle.board;
    this.w = this.board.w;
    this.h = this.board.h;
    this.st = createState(this.board);
    this.steps = [];
    // The whole derivation is computed once, from the clues alone. `solve()` is the same call the
    // generator used to *accept* this board, so a hint can never be a fact the clues do not force —
    // and "this board needs no guessing" and "the hints are always right" are one property, not two.
    this.script = solve(this.board).rows;
    this.cursor = 0;
    this.moves = 0;
    this.hints = 0;
    this.status = 'playing';
    // The brush a drag paints with. A tap still cycles 未知 → 黑 → 白 → 未知.
    this.mode = BLACK;
    this.lastHint = null;
    this.recompute();
  }

  recompute() {
    this.diag = diagnose(this.board, this.st.cell);
    this.violated = verify(this.board, this.st.cell);
    // `stuck` is the one thing a player cannot see coming: a single wrong black breaks no visible
    // count, so the engine has to be the one that says "no completion of this board exists".
    this.stuck = !reachable(this.board, this.st.cell);
    return this.diag;
  }

  cellAt(x, y) {
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return -1;
    return y * this.w + x;
  }

  valueOf(t) {
    return t >= 0 && t < this.board.n ? this.st.cell[t] : UNKNOWN;
  }

  // Every gesture consumes exactly one engine snapshot and records the cells it changed with their
  // prior values, so 撤销 is an exact reverse rather than a re-derivation.
  commit(kind, info) {
    this.steps.push({ kind, ...info });
    if (kind === 'hint') this.hints++;
    else this.moves++;
    this.recompute();
    this.checkWin();
    return this.steps[this.steps.length - 1];
  }

  // One tap = one step of the cycle the rules ask for. Tapping a clue cell is allowed and blamed:
  // a clue cell must be black, and finding that out is the player's first real move, not a freebie
  // the UI should hand over.
  tap(t) {
    if (this.status === 'won' || t < 0 || t >= this.board.n) return null;
    const from = this.st.cell[t];
    const to = nextValue(from);
    if (!setCell(this.st, t, to)) return null;
    return this.commit('tap', { writes: [{ cell: t, from, to }], value: to });
  }

  // A drag paints one value, never cycling — sweeping back over your own black must not turn it
  // white mid-gesture. The whole stroke is one step, so 撤销 takes back a stroke, not a cell of it.
  stroke(cells, value = this.mode) {
    if (this.status === 'won') return null;
    const written = setAll(this.st, cells, value);
    if (!written) return null;
    return this.commit('stroke', { writes: written, value });
  }

  load(cells) {
    for (let t = 0; t < this.board.n; t++) {
      const v = cells[t];
      this.st.cell[t] = v === BLACK || v === WHITE ? v : UNKNOWN;
    }
    this.recompute();
    this.checkWin();
    return this;
  }

  undo() {
    const step = this.steps.pop();
    if (!step) return null;
    undoState(this.st);
    for (const w of step.writes || []) this.st.cell[w.cell] = w.from;
    // A hint taken back is still a hint that was taken: records rank runs by help used, so
    // refunding the counter would let a player undo their way to a clean 提示 0.
    if (step.kind !== 'hint') this.moves = Math.max(0, this.moves - 1);
    this.recompute();
    return step;
  }

  // The next fact the clues force that the player has not written yet. Everything before it in the
  // script is already on the board, so a hint is one step of real progress — and when the script is
  // exhausted the board is solved, so "nothing to say" can never be charged for.
  hint() {
    if (this.status === 'won') return null;
    while (this.cursor < this.script.length) {
      const row = this.script[this.cursor];
      if (this.st.cell[row.cell] === row.value) {
        this.cursor++;
        continue;
      }
      if (this.st.cell[row.cell] !== UNKNOWN) {
        // The player's own mark contradicts what the clues force: say so, name the cell, and charge
        // nothing. A hint that hands over an answer is a spoiler; one that quietly agrees with a
        // wrong board is worse.
        return {
          conflict: `${this.board.name(row.cell)} 这里已经落了${valueName(this.st.cell[row.cell])}，可线索推出来必须是${valueName(row.value)}。先把这一步撤销掉，提示不会替你改。`,
          cell: row.cell,
        };
      }
      const from = this.st.cell[row.cell];
      setCell(this.st, row.cell, row.value);
      this.cursor++;
      this.commit('hint', { writes: [{ cell: row.cell, from, to: row.value }], value: row.value, rule: row.rule.name });
      const info = {
        rule: row.rule.name,
        cell: row.cell,
        value: row.value,
        clue: row.clue,
        slot: row.slot,
        kind: row.kind,
        why: row.why,
        charged: true,
      };
      this.lastHint = info;
      return info;
    }
    return { stalled: true, text: '线索能推的都已经推完了：剩下的格子已经全部落定。' };
  }

  checkWin() {
    this.status = complete(this.board, this.st.cell) ? 'won' : 'playing';
    return this.status === 'won';
  }

  // Used by the verification harness and the "show me the whole route" path: play the clue-derived
  // script to the end. Every cell it writes is one the pencil rules justify.
  solveWithLogic({ cap = 6000 } = {}) {
    let k = 0;
    while (this.status !== 'won' && k++ < cap) {
      const before = this.steps.length;
      const h = this.hint();
      if (!h || h.stalled || h.conflict) break;
      if (this.steps.length === before) break;
    }
    return { status: this.status, steps: k };
  }

  state() {
    const g = this.diag;
    return {
      tier: this.puzzle.tier,
      name: this.puzzle.tierName,
      seed: this.puzzle.seed,
      originSeed: this.puzzle.originSeed,
      moves: this.moves,
      hints: this.hints,
      status: this.status,
      blacks: g.blacks,
      whites: g.whites,
      total: g.total,
      remaining: g.remaining,
      clues: g.clues,
      satisfied: g.satisfied.size,
      conflicts: g.violated.size,
      blocks: g.blocks.size,
      problems: g.problems.length,
      stuck: this.stuck,
      script: this.script.length,
      cursor: this.cursor,
      score: this.puzzle.score,
      steps: this.steps.length,
      mode: this.mode,
    };
  }
}

// The one-line summary the panel shows for a hint: which rule, which cell, which colour. Built from
// the same row object the engine wrote, so it can never disagree with the board's own reasoning.
export function hintLine(info) {
  if (!info) return '';
  if (info.stalled) return info.text;
  if (info.conflict) return info.conflict;
  return `${info.rule} → ${info.cell} 是${valueName(info.value)}`;
}

export { Rules };
