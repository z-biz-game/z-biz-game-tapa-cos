// Synthesised feedback, no sample files. A puzzle game's sound is a *state* readout — "ink went
// down", "that black contradicts a clue", "every clue adds up" — and each of those is one short
// envelope, so a synth keeps the artifact small and the vocabulary honest. Zero audio files is a
// promise of the repo, not an optimisation.

import { BLACK, WHITE, UNKNOWN } from '../engine/tapa.js';

let ctx = null;
let master = null;
let enabled = true;
// 静音偏好：读回存档。放在模块顶层，这样每次 init（首屏、开局、重开）都拿到同一个答案，
// 重开一局不会把玩家的静音选择洗掉。
try {
  if (localStorage.getItem('cos.mute') === '1') enabled = false;
} catch { /* 读不到就沿用默认开声 */ }


function audio() {
  // 静音态第一行就返回：既不把已挂起的 ctx 拉起来，也不新建节点。
  // 这条比 "gain 设 0" 强一档——静音时这个 AudioContext 根本没有在跑。
  if (!enabled) return null;
  const Ctor = typeof AudioContext !== 'undefined' ? AudioContext : typeof webkitAudioContext !== 'undefined' ? webkitAudioContext : null;
  if (!Ctor) return null;
  if (!ctx) {
    try {
      ctx = new Ctor();
      master = ctx.createGain();
      master.gain.value = 0.5;
      master.connect(ctx.destination);
    } catch {
      return null;
    }
  }
  // Browsers start the context suspended until a gesture; a failed resume is not an error worth
  // throwing over, because the game is fully playable in silence.
  if (ctx.state === 'suspended') ctx.resume().catch(() => {});
  return ctx;
}

// One oscillator with a two-point pitch glide and an exponential decay. Everything below is a call
// to this; adding a second voice shape is how a game ends up with sounds that do not belong to the
// same instrument.
function tone({ f0, f1 = f0, dur = 0.12, type = 'sine', gain = 0.22, delay = 0 }) {
  const ac = audio();
  if (!ac || !enabled) return;
  const t = ac.currentTime + delay;
  const osc = ac.createOscillator();
  const vol = ac.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(f0, t);
  osc.frequency.exponentialRampToValueAtTime(Math.max(40, f1), t + dur);
  vol.gain.setValueAtTime(0.0001, t);
  vol.gain.exponentialRampToValueAtTime(gain, t + 0.012);
  vol.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  osc.connect(vol).connect(master);
  osc.start(t);
  osc.stop(t + dur + 0.02);
}

export const Sound = {
  setEnabled(v) {
    const on = !!v;
    if (on === enabled) return;
    enabled = on;
    // 真静音：停掉 AudioContext 本身（时钟停、图不跑），不是把音量拧到 0。
    if (ctx) {
      if (on) {
        if (ctx.state === 'suspended' && ctx.resume) ctx.resume().catch(() => {});
      } else if (ctx.state === 'running' && ctx.suspend) {
        ctx.suspend().catch(() => {});
      }
    }
    // 偏好落盘：刷新页面后 init 要能读回静音态，不能自己弹回来。
    try {
      localStorage.setItem('cos.mute', on ? '1' : '0');
    } catch { /* 隐私模式下写不进去也不该炸游戏 */ }
  },
  enabled: () => enabled,

  // Black is the downward, heavier gesture; white the lifted one. They are the two sounds a player
  // makes hundreds of times a board, so the pair has to be distinguishable with the eyes elsewhere.
  black() {
    tone({ f0: 420, f1: 240, dur: 0.09, type: 'triangle', gain: 0.18 });
  },
  white() {
    tone({ f0: 560, f1: 880, dur: 0.11, type: 'sine', gain: 0.15 });
  },
  erase() {
    tone({ f0: 240, f1: 180, dur: 0.08, type: 'sine', gain: 0.1 });
  },
  // One name the UI calls for "a stroke landed", whatever it was painted with. The three engine
  // values are imported rather than re-typed, so a sound cannot be attached to the wrong colour if
  // the engine ever renumbers them.
  place(value) {
    if (value === WHITE) Sound.white();
    else if (value === UNKNOWN) Sound.erase();
    else if (value === BLACK) Sound.black();
  },
  undo() {
    tone({ f0: 420, f1: 300, dur: 0.11, type: 'triangle', gain: 0.13 });
  },
  // Two detuned voices: an interval that is deliberately unpleasant, for the one thing the player
  // must notice without looking.
  conflict() {
    tone({ f0: 200, f1: 150, dur: 0.16, type: 'sawtooth', gain: 0.11 });
    tone({ f0: 214, f1: 158, dur: 0.16, type: 'sawtooth', gain: 0.09, delay: 0.01 });
  },
  hint() {
    tone({ f0: 760, f1: 1020, dur: 0.16, type: 'sine', gain: 0.16 });
    tone({ f0: 1140, dur: 0.1, type: 'sine', gain: 0.07, delay: 0.06 });
  },
  win() {
    [523, 659, 784, 1046].forEach((f, i) => tone({ f0: f, dur: 0.26, type: 'triangle', gain: 0.17, delay: i * 0.09 }));
  },
};
