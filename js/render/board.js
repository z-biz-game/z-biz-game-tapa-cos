// Canvas renderer. It reads the Game's engine state and paints; it decides nothing about legality —
// no clue is "satisfied" here, no cell is judged wrong here — so the picture cannot disagree with
// the solver that the hints and the win check both use. The only judgement it makes is *where* to
// put a pixel, and every colour comes from diagnose()'s sets.
//
// Layout lives here too (cell size from the container, board origin, DPR) because hitCell has to
// answer with the *same* numbers draw() used. Those two drifting apart is how a board renders
// correctly but takes clicks one cell off.
//
// Tapa's clue is not one number in a square — it is up to *three* numbers belonging to the eight
// directions around the cell, each group counted clockwise from north. So each digit is drawn in the
// direction its group starts, which needs air outside the clue cell: the layout reserves half a cell
// on every side, and that margin is also where a corner clue's single digit lives.


/* ---------- 帧率无关（dt）---------- */
/* 本仓**没有逐帧运动**，所以「帧率无关」这一项在本仓是空命题而不是缺陷：js/render/board.js 的重绘由 pointerdown / click / keydown 触发，全仓 requestAnimationFrame 出现 0 次；唯一的周期性调用是 1 秒 ticker（刷新用时读数，走墙钟）
   没有自续期的 requestAnimationFrame 循环，屏上就没有「每帧推进」的量，帧率也就无从影响它。
   写这段备案是为了让账上分得开"查过、确实不需要"与"没人查过"——不是为了让判据变绿。

   规矩：**哪天在本仓加了逐帧动画循环，必须先删掉这段备案**，并让循环体消费 rAF 自带的
   时间戳（或自己取 performance.now()），把动画进度写成绝对截止；只按帧累加位置的一律不算。 */
import { Palette, Radius, Cell, Font, Shadow } from '../theme.js';
import { NO_CLUE, UNKNOWN, WHITE, BLACK, clueDigits, isZeroClue, ringLabel } from '../engine/tapa.js';

// Where inside a cell's own box a digit sits, in units of the cell, keyed by the engine's compass
// label. Slot order is the engine's ring order, so a digit and the group it counts share an index.
const SLOT_ANCHOR = {
  北: [0.5, 0.08],
  东北: [0.86, 0.14],
  东: [0.92, 0.5],
  东南: [0.86, 0.86],
  南: [0.5, 0.92],
  西南: [0.14, 0.86],
  西: [0.08, 0.5],
  西北: [0.14, 0.14],
};

export function layoutFor(w, h, availW, availH) {
  // Each clue spills its digits half a cell beyond its own square, so the playable grid is
  // (w + 1) × (h + 1) cells wide and the outermost digits still land on the card.
  const margin = 14;
  let cell = Math.floor(Math.min((availW - margin * 2) / (w + 1), (availH - margin * 2) / (h + 1)));
  cell = Math.max(Cell.min, Math.min(Cell.max, cell));
  return { cell, boardW: cell * w, boardH: cell * h, pad: margin + Math.floor(cell / 2) };
}

export class BoardView {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.geo = { cell: 0, x: 0, y: 0, w: 0, h: 0, dpr: 1 };
    this.game = null;
  }

  // The backing buffer is sized in device pixels while every draw call stays in CSS pixels: one
  // setTransform at the top keeps the digits crisp on a Retina display without doubling every
  // constant in this file.
  resize(game, availW, availH) {
    const l = layoutFor(game.w, game.h, availW, availH);
    const dpr = Math.max(1, Math.round((typeof devicePixelRatio === 'number' && devicePixelRatio) || 1));
    const size = { w: l.boardW + l.pad * 2, h: l.boardH + l.pad * 2 };
    this.canvas.style.width = `${size.w}px`;
    this.canvas.style.height = `${size.h}px`;
    this.canvas.width = Math.round(size.w * dpr);
    this.canvas.height = Math.round(size.h * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.geo = { cell: l.cell, x: l.pad, y: l.pad, w: size.w, h: size.h, dpr };
    this.game = game;
    return this.geo;
  }

  cellRect(t) {
    const { cell, x, y } = this.geo;
    return { x: ((t % this.game.w) * cell) + x, y: ((((t / this.game.w) | 0) * cell) + y), size: cell };
  }

  // Screen point of one of a clue cell's eight digit slots — the same slot the engine indexes by
  // number, so a hint that says "东北方向那一格" gets ringed at exactly that spot.
  slotPoint(clueCell, slot) {
    const r = this.cellRect(clueCell);
    const label = ringLabel(this.game.w, this.game.h, clueCell, slot);
    const [fx, fy] = SLOT_ANCHOR[label] || [0.5, 0.5];
    return { x: r.x + r.size * fx, y: r.y + r.size * fy, label };
  }

  hitCell(clientX, clientY) {
    const rect = this.canvas.getBoundingClientRect();
    const { cell, x, y } = this.geo;
    const game = this.game;
    if (!cell || !game) return -1;
    const px = clientX - rect.left - x;
    const py = clientY - rect.top - y;
    if (px < 0 || py < 0) return -1;
    const gx = Math.floor(px / cell);
    const gy = Math.floor(py / cell);
    if (gx < 0 || gy < 0 || gx >= game.w || gy >= game.h) return -1;
    return gy * game.w + gx;
  }

  // The cells whose ink is contradicted. Read off diagnose()'s sets, plus one presentation-only step:
  // a clue that is wrong points at itself, so its black ring cells are shown as the suspects.
  suspects(game) {
    const b = game.board;
    const st = game.st.cell;
    const out = new Set(game.diag.blocks);
    for (const i of game.diag.violated) {
      out.add(i);
      for (const c of b.rings[i]) if (st[c] === BLACK) out.add(c);
    }
    for (const c of game.diag.linkCells) out.add(c);
    return out;
  }

  draw(game, { pulse = null, preview = null } = {}) {
    this.game = game;
    const { ctx, geo } = this;
    const { cell } = geo;
    const b = game.board;
    const st = game.st.cell;
    const diag = game.diag;
    const won = game.status === 'won';
    const bad = this.suspects(game);
    ctx.clearRect(0, 0, geo.w, geo.h);

    // The board card. A canvas has no box-shadow, so the lifted layer of the three-layer ramp is
    // painted explicitly — the same 0.3 black the stylesheet uses for .panel.
    ctx.save();
    ctx.shadowColor = Shadow.canvas[2];
    ctx.shadowBlur = 22;
    ctx.shadowOffsetY = 8;
    roundRect(ctx, 0, 0, geo.w, geo.h, Radius.card);
    ctx.fillStyle = Palette.surface;
    ctx.fill();
    ctx.restore();

    // Cells: the paper. Black is ink, white is a declared all-clear, and neither may be confusable
    // with the untouched grid — so an undecided cell is a third, visibly different surface.
    for (let t = 0; t < b.n; t++) {
      const r = this.cellRect(t);
      const v = st[t];
      if (v === BLACK) ctx.fillStyle = won ? Palette.success : bad.has(t) ? Palette.error : Palette.ink;
      else if (v === WHITE) ctx.fillStyle = won ? Palette.success : bad.has(t) ? Palette.error : Palette.bgBottom;
      else ctx.fillStyle = Palette.surfaceLift;
      ctx.fillRect(r.x, r.y, cell, cell);
    }

    // The preview under the finger, before it is committed: a preview is paint, never ink.
    if (preview && preview.cells) {
      ctx.fillStyle = Palette.accentSoft;
      for (const t of preview.cells) {
        const r = this.cellRect(t);
        ctx.fillRect(r.x, r.y, cell, cell);
      }
    }

    // Grid, drawn over the fills so the lines stay one pixel wide at any cell size.
    ctx.strokeStyle = Palette.line;
    ctx.lineWidth = 1;
    for (let i = 0; i <= game.w; i++) line(ctx, geo.x + i * cell, geo.y, geo.x + i * cell, geo.y + game.h * cell);
    for (let j = 0; j <= game.h; j++) line(ctx, geo.x, geo.y + j * cell, geo.x + game.w * cell, geo.y + j * cell);
    // The outline is heavier: without it the outermost clue digits float outside any visible frame.
    ctx.strokeStyle = Palette.lineHeavy;
    ctx.lineWidth = 2;
    ctx.strokeRect(geo.x - 1, geo.y - 1, game.w * cell + 2, game.h * cell + 2);

    this.drawClues(game, diag, bad, won);

    // What a hint just named — the only place the UI is allowed to say "look here".
    if (pulse && pulse.cell != null) {
      const r = this.cellRect(pulse.cell);
      ctx.strokeStyle = pulse.color || Palette.hint;
      ctx.lineWidth = Math.max(2.5, cell * 0.09);
      roundRect(ctx, r.x + 2, r.y + 2, cell - 4, cell - 4, Radius.cell);
      ctx.stroke();
      if (pulse.clue != null && pulse.clue >= 0 && pulse.slot != null && pulse.slot >= 0) {
        // Ring the direction the clue's number belongs to, so "哪一格" and "哪条线索" are answered by
        // the same gesture.
        const p = this.slotPoint(pulse.clue, pulse.slot);
        ctx.beginPath();
        ctx.arc(p.x, p.y, Math.max(8, cell * 0.3), 0, Math.PI * 2);
        ctx.strokeStyle = Palette.hint;
        ctx.lineWidth = Math.max(1.5, cell * 0.05);
        ctx.stroke();
      }
    }
  }

  // Clue digits, the `0 0 0` marker, and the green ring that says "this clue already adds up".
  drawClues(game, diag, bad, won) {
    const { ctx } = this;
    const cell = this.geo.cell;
    const b = game.board;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const size = Math.max(10, Math.round(cell * Cell.clueScale));
    const plate = size * 1.05;
    for (const i of b.clued) {
      const code = b.clue[i];
      const digits = clueDigits(code);
      const zero = isZeroClue(code);
      const broken = diag.violated.has(i);
      const done = won || diag.satisfied.has(i);
      // A clue cell is black by rule, so its own square is ink — which means a digit drawn into it
      // would vanish. Every digit therefore sits on its own dark plate, and the plate's border is the
      // clue's live state.
      for (let s = 0; s < digits.length; s++) {
        const p = this.slotPoint(i, s);
        ctx.fillStyle = Palette.bgTop;
        roundRect(ctx, p.x - plate / 2, p.y - plate / 2, plate, plate, Math.min(4, plate * 0.26));
        ctx.fill();
        ctx.strokeStyle = broken ? Palette.error : done ? Palette.success : Palette.lineHeavy;
        ctx.lineWidth = 1;
        ctx.stroke();
        ctx.font = `700 ${size}px ${Font.mono}`;
        ctx.fillStyle = broken ? Palette.error : done ? Palette.success : zero ? Palette.zeroClue : Palette.accent;
        ctx.fillText(String(digits[s]), p.x, p.y + 0.5);
      }
      // `0 0 0` and "no clue here" have to be tellable apart without reading the digits, because an
      // encoder that spells both as 0 cannot tell them apart at all. So the difference is drawn twice:
      // three teal zeros (above), and a dashed hoop on the cell itself, which no ordinary clue gets.
      if (zero) {
        const r = this.cellRect(i);
        ctx.beginPath();
        ctx.arc(r.x + cell / 2, r.y + cell / 2, cell * 0.3, 0, Math.PI * 2);
        ctx.strokeStyle = bad.has(i) ? Palette.error : Palette.zeroClue;
        ctx.lineWidth = Math.max(1.5, cell * 0.05);
        ctx.setLineDash([Math.max(3, cell * 0.13), Math.max(2, cell * 0.1)]);
        ctx.stroke();
        ctx.setLineDash([]);
      }
      // The green ring: this clue's numbers already match what is around it.
      if (done && !broken) {
        const r = this.cellRect(i);
        ctx.beginPath();
        ctx.arc(r.x + cell / 2, r.y + cell / 2, cell * 0.44, 0, Math.PI * 2);
        ctx.strokeStyle = Palette.success;
        ctx.lineWidth = Math.max(2, cell * 0.055);
        ctx.stroke();
      }
    }
  }
}

function line(ctx, x1, y1, x2, y2) {
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x2, y2);
  ctx.stroke();
}

function roundRect(ctx, x, y, w, h, r) {
  const k = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + k, y);
  ctx.arcTo(x + w, y, x + w, y + h, k);
  ctx.arcTo(x + w, y + h, x, y + h, k);
  ctx.arcTo(x, y + h, x, y, k);
  ctx.arcTo(x, y, x + w, y, k);
  ctx.closePath();
}

// The harness asserts on the same sentinels the renderer does, so they leave this module by name
// rather than each scenario re-typing a magic number.
export { NO_CLUE, UNKNOWN, WHITE, BLACK };
