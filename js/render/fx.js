// Ink flecks — the only thing in this game that moves on its own after a tap.
//
// The simulation runs on a **fixed step** (SIM_STEP) inside an accumulator that is filled by the
// frame delta. That is the difference between "identical board at 3 s whether the device paints at
// 30, 60 or 120 Hz" and a splash that weighs itself differently on every phone: per-frame
// integration (`p.x += p.vx * frameDt`, `p.life -= frameDt`) makes the step size a property of the
// display, and a 30 Hz tablet then loses half the flecks before they land. So nothing below reads a
// frame delta at all — the frame delta only ever decides *how many* whole steps the accumulator buys,
// and DRAG_STEP is derived from SIM_STEP rather than from "a frame".
//
// Coordinates are CSS pixels of the board canvas, so a fleck stays glued to the cell it came out of
// when the layout re-flows on resize (it is short-lived enough that re-anchoring is not worth a
// second coordinate space).

import { Palette } from '../theme.js';
import { BLACK } from '../engine/tapa.js';
import { motif } from './assets.js';

const SIM_STEP = 1 / 120; // seconds of simulated time per step
// 减法亏损不许吞掉一整个 SIM_STEP：`accum -= SIM_STEP` 在 30/60Hz 的帧长下每帧都留下
// "只差 3e-18 就够再走一步"的零头，实测喂 500ms 只走 59 步（应为 60）——低帧率的动画就慢这一拍。
// 1e-9 秒的容差比任何真实帧间隔小六个数量级，只把这点减法亏损判回"够一步"。
const STEP_EPS = 1e-9;
const MAX_STEPS_PER_FRAME = 8; // a backgrounded tab buys a catch-up budget, not an avalanche
const GRAVITY = 620; // px/s² — ink falls, it does not float
const DRAG_PER_SEC = 0.12; // velocity retained after one second of flight
const DRAG_STEP = Math.pow(DRAG_PER_SEC, SIM_STEP); // exact for the fixed step, at any frame rate
const CAP = 220;

const rnd = (a, b) => a + Math.random() * (b - a);

export class InkFx {
  constructor() {
    this.items = [];
    this.accum = 0;
    this.simTime = 0;
    this.simSteps = 0;
    this.enabled = true;
  }

  setEnabled(on) {
    this.enabled = !!on;
    if (!this.enabled) this.items.length = 0;
  }

  // 重开 / 换局 / 回菜单都要调这里：累加器若留着上局的零头，新局的第一帧就多走一步。
  reset() {
    this.items.length = 0;
    this.accum = 0;
    this.simTime = 0;
    this.simSteps = 0;
  }

  // One cell's worth of ink kicked up by a write. `count` stays small: this is a brush tapping a
  // paper board, not a firework, and 220 flecks is the ceiling for a whole screen of them.
  splash(x, y, cell, value, count = 7) {
    if (!this.enabled) return 0;
    const n = Math.max(0, Math.min(count, CAP - this.items.length));
    for (let i = 0; i < n; i++) {
      const up = rnd(0.35, 1.0);
      this.items.push({
        x: x + rnd(-cell * 0.3, cell * 0.3),
        y: y + rnd(-cell * 0.2, cell * 0.2),
        vx: rnd(-cell * 2.2, cell * 2.2),
        vy: -cell * (4.2 + up * 3.4),
        size: cell * rnd(0.05, 0.13),
        life: rnd(0.3, 0.62),
        max: 0.62,
        spin: rnd(-6, 6),
        rot: rnd(0, Math.PI * 2),
        tone: value === BLACK ? Palette.ink : Palette.line,
        sprited: value === BLACK,
      });
    }
    return n;
  }

  // The win flourish: one wide throw from the middle of the board, gold and ink both.
  celebrate(w, h) {
    if (!this.enabled) return 0;
    const n = Math.max(0, Math.min(46, CAP - this.items.length));
    for (let i = 0; i < n; i++) {
      const a = rnd(-Math.PI, 0);
      const sp = rnd(h * 0.9, h * 2.1);
      this.items.push({
        x: w / 2 + rnd(-w * 0.18, w * 0.18),
        y: h * 0.62,
        vx: Math.cos(a) * sp,
        vy: Math.sin(a) * sp,
        size: rnd(3, 7),
        life: rnd(0.7, 1.5),
        max: 1.5,
        spin: rnd(-9, 9),
        rot: rnd(0, Math.PI * 2),
        tone: i % 3 === 0 ? Palette.accent : i % 3 === 1 ? Palette.zeroClue : Palette.ink,
        sprited: true,
      });
    }
    return n;
  }

  // Filled by the frame delta, spent in whole SIM_STEPs — the one place frame time is read, and it
  // is read as an amount of time, never as an amount of motion.
  advance(elapsedSeconds) {
    const dt = elapsedSeconds > 0 ? Math.min(elapsedSeconds, 0.25) : 0;
    this.accum += dt;
    let steps = 0;
    while (this.accum + STEP_EPS >= SIM_STEP && steps < MAX_STEPS_PER_FRAME) {
      this.step(SIM_STEP);
      this.accum -= SIM_STEP;
      steps++;
    }
    if (steps === MAX_STEPS_PER_FRAME) this.accum = 0;
    return steps;
  }

  step(s) {
    const items = this.items;
    for (let i = items.length - 1; i >= 0; i--) {
      const p = items[i];
      p.vy += GRAVITY * s;
      p.vx *= DRAG_STEP;
      p.vy *= DRAG_STEP;
      p.x += p.vx * s;
      p.y += p.vy * s;
      p.rot += p.spin * s;
      p.life -= s;
      if (p.life <= 0) items.splice(i, 1);
    }
    this.simTime += s;
    this.simSteps++;
  }

  active() {
    return this.items.length > 0;
  }

  draw(ctx) {
    if (!this.items.length) return;
    const sprite = motif('ink');
    ctx.save();
    for (const p of this.items) {
      const k = p.life > 0 ? p.life / p.max : 0;
      ctx.globalAlpha = Math.min(1, k * 1.6);
      ctx.fillStyle = p.tone;
      const s = p.size * (0.6 + k * 0.4);
      if (sprite && p.sprited) {
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate(p.rot);
        ctx.drawImage(sprite, -s, -s, s * 2, s * 2);
        ctx.restore();
      } else {
        ctx.fillRect(p.x - s / 2, p.y - s / 2, s, s);
      }
    }
    ctx.restore();
    ctx.globalAlpha = 1;
  }

  // Read by the verification harness: what the simulation is made of, not what it looks like.
  state() {
    let sumX = 0;
    let sumY = 0;
    let sumLife = 0;
    for (const p of this.items) {
      sumX += p.x;
      sumY += p.y;
      sumLife += p.life;
    }
    return {
      count: this.items.length,
      simSteps: this.simSteps,
      simTime: Math.round(this.simTime * 1e6) / 1e6,
      accumMs: Math.round(this.accum * 1e6) / 1e6,
      sumX: Math.round(sumX * 1000) / 1000,
      sumY: Math.round(sumY * 1000) / 1000,
      sumLife: Math.round(sumLife * 1e6) / 1e6,
      enabled: this.enabled,
    };
  }
}

export { SIM_STEP };
