// Wiring: DOM, pointer gestures, the clock, storage, and the `window.tapa` surface the verification
// harness drives. No rule about the board lives here — every judgement (what a cell may be, whether
// the board adds up, what a hint may say) comes from js/engine/tapa.js through js/ui/game.js.

import { Palette, Cell, applyThemeVars, setReduceMotion, systemPrefersReducedMotion } from './theme.js';
import { Sound } from './audio/synth.js';
import { Store } from './store.js';
import { TIERS, tierFor, tierIndexFor, generate, randomInk } from './engine/generate.js';
import { LIBRARY, byTier } from './data/library.js';
import { dayKey } from './engine/rng.js';
import * as Engine from './engine/tapa.js';
import { analyze } from './engine/count.js';
import { BoardView } from './render/board.js';
import { Game, valueName, hintLine, BLACK, WHITE, UNKNOWN } from './ui/game.js';

const VERSION = '1.0.0';

const $ = (sel) => document.querySelector(sel);
const el = {
  viewMenu: $('#view-menu'),
  viewGame: $('#view-game'),
  tiers: $('#tier-list'),
  records: $('#record-list'),
  resumeCard: $('#resume-card'),
  resumeName: $('#resume-name'),
  resumeMeta: $('#resume-meta'),
  name: $('#stat-name'),
  tier: $('#stat-tier'),
  time: $('#stat-time'),
  moves: $('#stat-moves'),
  hints: $('#stat-hints'),
  blacks: $('#stat-blacks'),
  whites: $('#stat-whites'),
  remaining: $('#stat-remaining'),
  satisfied: $('#stat-satisfied'),
  conflicts: $('#stat-conflicts'),
  score: $('#stat-score'),
  hintRule: $('#hint-rule'),
  hintLine: $('#hint-line'),
  hintCount: $('#hint-count'),
  stateLine: $('#state-line'),
  winVeil: $('#win-veil'),
  winMeta: $('#win-meta'),
  winRecord: $('#win-record'),
  wrap: $('#board-wrap'),
  canvas: $('#board'),
};

const view = new BoardView(el.canvas);
let game = null;
let pulse = null;
let stroke = null;
let pulseTimer = 0;
let startedAt = 0;
let baseElapsed = 0;
let ticker = 0;

const clock = () => baseElapsed + (startedAt ? Date.now() - startedAt : 0);
const running = () => !!startedAt;

function fmtMs(ms) {
  const s = Math.floor(ms / 1000);
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

// ---- the puzzle ------------------------------------------------------------
// `generate` already returns the board object the engine solved when it accepted this puzzle, so the
// app never rebuilds a clue array by hand — one less place for a sentinel to be mistranslated. The
// origin seed rides along because the save file stores it, not the numeric seed the generator ended
// up using.
function puzzleFrom(origin, tier) {
  const g = generate(origin, tier);
  if (!g) return null;
  return { ...g, originSeed: origin, tierName: TIERS[g.tier].name };
}

// Which board an opening gets: the campaign rows tools/bake.mjs re-verified, walked in order, and
// then a seed derived from the calendar day — so two players who open 中等 on the same day are
// looking at the same numbers, and neither of them is looking at a board nobody measured.
// `Math.random()` is deliberately absent: a game that stores its runs by seed cannot hand out
// unrepeatable seeds.
const campaignWalk = new Map();
function defaultSeed(tier) {
  const key = TIERS[tierIndexFor(tier)].key;
  const list = byTier(key);
  const i = campaignWalk.get(key) || 0;
  campaignWalk.set(key, i + 1);
  if (i < list.length) return list[i].seed;
  return `day|${dayKey()}|${key}|${i - list.length}`;
}

function availBox() {
  const narrow = window.innerWidth <= 900;
  const w = narrow ? window.innerWidth - 60 : el.viewGame.clientWidth - 340;
  return { w: Math.max(240, w), h: Math.max(240, window.innerHeight - 250) };
}

function draw() {
  if (!game) return;
  const { w, h } = availBox();
  view.resize(game, w, h);
  view.draw(game, {
    pulse,
    preview: stroke && stroke.items.length ? { cells: stroke.items.map((i) => i.cell) } : null,
  });
}

// One place writes the readouts, so a stat can never be updated by half the file.
function syncStats() {
  if (!game) return;
  const st = game.state();
  el.name.textContent = `${st.name} · ${game.w}×${game.h}`;
  el.tier.textContent = tierFor(st.tier).name;
  el.tier.dataset.tier = st.tier;
  el.time.textContent = fmtMs(clock());
  el.moves.textContent = st.moves;
  el.hints.textContent = st.hints;
  el.hintCount.textContent = st.hints;
  el.blacks.textContent = st.blacks;
  el.whites.textContent = st.whites;
  el.remaining.textContent = st.remaining;
  el.satisfied.textContent = `${st.satisfied}/${st.clues}`;
  el.conflicts.textContent = st.problems;
  el.score.textContent = st.score.toFixed(1);
  el.conflicts.closest('.stat').classList.toggle('bad', st.problems > 0);
  el.remaining.closest('.stat').classList.toggle('bad', st.status !== 'won' && st.stuck);
  el.satisfied.closest('.stat').classList.toggle('bad', st.status !== 'won' && st.problems > 0);
  el.stateLine.textContent = st.stuck
    ? '这些格子已经和数字矛盾了：不管剩下的格怎么染，都不可能让所有线索对上。撤销一步再想。'
    : st.problems
      ? `${st.problems} 处对不上：有二乘二全黑了，白格被围死了，或者某个数字周围的段数不对。`
      : '';
}

function syncAll() {
  syncStats();
  draw();
}

function flushResume() {
  if (!game || game.status === 'won') return;
  Store.saveResume(game.puzzle, game.st.cell, clock(), { moves: game.moves, hints: game.hints });
}

function startClock() {
  startedAt = Date.now();
  clearInterval(ticker);
  ticker = setInterval(() => {
    el.time.textContent = fmtMs(clock());
    if (pulse) draw();
  }, 1000);
}

function stopClock() {
  baseElapsed = clock();
  startedAt = 0;
  clearInterval(ticker);
  ticker = 0;
}

// The brush a drag paints with. A tap still cycles, so the brush is only half the gesture story.
function setMode(value) {
  if (!game) return;
  game.mode = value;
  for (const [id, v] of [['#btn-mode-black', BLACK], ['#btn-mode-white', WHITE], ['#btn-mode-erase', UNKNOWN]]) {
    $(id).setAttribute('aria-pressed', String(v === value));
  }
  el.canvas.dataset.mode = value === BLACK ? 'black' : value === WHITE ? 'white' : 'erase';
  draw();
}

function clearPulse() {
  clearTimeout(pulseTimer);
  pulseTimer = 0;
  pulse = null;
}

function showHint(info) {
  if (!info) return;
  if (info.stalled) {
    el.hintRule.textContent = '推不动了';
    el.hintLine.textContent = info.text;
    return;
  }
  if (info.conflict) {
    el.hintRule.textContent = '这里和线索矛盾';
    el.hintLine.textContent = info.conflict;
    pulse = { cell: info.cell, color: 'rgba(255,92,122,0.9)' };
    pulseTimer = setTimeout(() => {
      clearPulse();
      draw();
    }, 1600);
    Sound.conflict();
    return;
  }
  el.hintRule.textContent = `规则：${info.rule}`;
  el.hintLine.textContent = info.why;
  pulse = { cell: info.cell, clue: info.clue, slot: info.slot };
  const mine = pulse;
  pulseTimer = setTimeout(() => {
    if (pulse === mine) {
      pulse = null;
      draw();
    }
  }, 1600);
  Sound.hint();
}

function onWin() {
  stopClock();
  const ms = clock();
  // Records are filed by tier *key* (`Store.best('hard')`, which is how renderRecords reads them and
  // how tools/engine-test.mjs spells them), while a puzzle carries the tier *index* it was generated
  // with (js/engine/generate.js:203). Handing the index over wrote data.best["3"]: the run was
  // recorded and then read back by nothing — the 纪录 table stayed on 还没有纪录 and every win
  // claimed 新纪录.
  const better = Store.recordBest(TIERS[game.puzzle.tier].key, {
    ms,
    hints: game.hints,
    moves: game.moves,
    size: `${game.w}×${game.h}`,
  });
  Store.recordSolve(ms, game.hints);
  Store.clearResume();
  el.winMeta.textContent = `${tierFor(game.puzzle.tier).name} · ${game.w}×${game.h} · ${fmtMs(ms)} · ${game.moves} 步 · 提示 ${game.hints} 次`;
  el.winRecord.textContent = better ? '新纪录：这一局比存档里的更不求人。' : '未破纪录：同档先比提示次数。';
  el.winVeil.hidden = false;
  Sound.win();
  renderRecords();
}

function afterStep(soundValue) {
  syncAll();
  if (game.status === 'won') onWin();
  else {
    flushResume();
    if (soundValue !== null) Sound.place(soundValue);
    if (game.stuck || game.violated.length) Sound.conflict();
  }
}

function useHint() {
  if (!game || game.status === 'won') return null;
  const before = game.hints;
  const info = game.hint();
  if (!info) return null;
  // An unproductive hint is not a purchase: nothing was written, nothing is charged.
  if (info.stalled || info.conflict) {
    showHint(info);
    return info;
  }
  showHint(info);
  if (game.hints !== before) afterStep(info.value);
  return info;
}

function undo() {
  if (!game) return null;
  const step = game.undo();
  if (!step) return null;
  clearPulse();
  Sound.undo();
  syncAll();
  flushResume();
  return step;
}

function begin({ tier = TIERS[0].key, seed = null, resume = null } = {}) {
  const origin = seed || defaultSeed(tierIndexFor(tier));
  const puzzle = puzzleFrom(origin, tierIndexFor(tier));
  if (!puzzle) return null;
  game = new Game(puzzle);
  clearPulse();
  stroke = null;
  el.winVeil.hidden = true;
  baseElapsed = 0;
  // A save that does not fit the board it is being replayed onto is dropped whole: the run starts
  // clean rather than resuming a shifted picture with someone else's clock on it.
  const sheet = resume ? Store.resumeBoard(game.board.n) : null;
  if (sheet) {
    game.moves = resume.moves || 0;
    game.hints = resume.hints || 0;
    baseElapsed = resume.elapsedMs || 0;
    game.cursor = 0;
    game.load(sheet);
  }
  setMode(BLACK);
  show('game');
  startClock();
  el.hintRule.textContent = '提示理由';
  el.hintLine.textContent = '按 提示 会说出当前能推的一格，以及它依据哪条规则。';
  syncAll();
  flushResume();
  renderResumeCard();
  return game;
}

function show(which) {
  el.viewMenu.hidden = which !== 'menu';
  el.viewGame.hidden = which !== 'game';
  if (which === 'menu') {
    stopClock();
    renderMenu();
  }
  if (which === 'game') draw();
  return which;
}

function renderMenu() {
  renderTiers();
  renderRecords();
  renderResumeCard();
}

const TIER_NOTE = {
  newbie: '环小数字密，一条线索自己就推得完',
  easy: '要开始顺着环数段数：哪一段还能长，哪一段只能这么长',
  medium: '数字稀了，二乘二和白格连通要一起用',
  hard: '一格要看好几条线索的交集，反证开始上场',
  master: '盘大环多，一步没想清楚整片对不上',
};

function renderTiers() {
  el.tiers.innerHTML = '';
  TIERS.forEach((t, i) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'tier';
    b.dataset.tier = t.key;
    b.innerHTML =
      `<span class="tier-name">${i + 1} · ${t.name}</span>` +
      `<span class="tier-note">${TIER_NOTE[t.key] || ''}</span>` +
      `<span class="tier-size mono">${t.size.join('×')} · 实测 ${t.band[0]}–${t.band[1]}</span>`;
    b.addEventListener('click', () => begin({ tier: t.key }));
    el.tiers.appendChild(b);
  });
}

function renderRecords() {
  el.records.innerHTML = '';
  for (const t of TIERS) {
    const li = document.createElement('li');
    const best = Store.best(t.key);
    li.dataset.tier = t.key;
    li.innerHTML =
      `<b>${t.name}</b>` +
      (best
        ? `<span class="mono">${fmtMs(best.ms)}</span> · 提示 ${best.hints} · ${best.moves} 步<br><span>${best.size}</span>`
        : '<span>还没有纪录</span>');
    el.records.appendChild(li);
  }
}

function renderResumeCard() {
  const r = Store.resume();
  // Do not offer "继续" for the board already on screen.
  const live = game && game.status !== 'won' && running();
  if (!r || (live && r.seed === game.puzzle.originSeed && r.tier === game.puzzle.tier)) {
    el.resumeCard.hidden = true;
    return;
  }
  el.resumeCard.hidden = false;
  el.resumeName.textContent = `继续 ${tierFor(r.tier).name} 的一局`;
  el.resumeMeta.textContent = `${fmtMs(r.elapsedMs || 0)} · ${r.moves || 0} 步 · 提示 ${r.hints || 0} 次`;
}

function applySettings() {
  Sound.setEnabled(Store.setting('sound'));
  const reduce = !!Store.setting('reduceMotion') || systemPrefersReducedMotion();
  setReduceMotion(!!Store.setting('reduceMotion'));
  document.body.classList.toggle('reduce-motion', reduce);
  $('#btn-sound').setAttribute('aria-pressed', String(!!Store.setting('sound')));
  $('#btn-sound').textContent = Store.setting('sound') ? '音效 开' : '音效 关';
  $('#btn-motion').setAttribute('aria-pressed', String(!!Store.setting('reduceMotion')));
  $('#btn-motion').textContent = reduce ? '动效 省' : '动效 全';
}

// ---- pointer gestures ------------------------------------------------------
// A press that stays on one cell is a tap (cycle 未知→黑→白); a press that travels is a stroke
// painted with the brush. Both commit exactly one engine step, so 撤销 takes back what the player
// thinks they did — a click, or one swipe.
function preview(t, value) {
  stroke.items.push({ cell: t, from: game.st.cell[t] });
  game.st.cell[t] = value;
  game.recompute();
}

function unpreview(s = stroke) {
  for (const it of s.items) game.st.cell[it.cell] = it.from;
  game.recompute();
}

function strokeStart(ev) {
  if (!game || game.status === 'won') return;
  const t = view.hitCell(ev.clientX, ev.clientY);
  if (t < 0) return;
  ev.preventDefault();
  el.canvas.setPointerCapture?.(ev.pointerId);
  clearPulse();
  // The right-button gesture is the eraser: sweeping over your own ink to clear it is the one thing
  // a player reaches for before 撤销.
  const value = ev.button === 2 ? UNKNOWN : game.mode;
  stroke = { items: [], value, anchor: t, moved: false };
  preview(t, value);
  draw();
}

function strokeMove(ev) {
  if (!stroke || !game) return;
  const t = view.hitCell(ev.clientX, ev.clientY);
  // Sweeping back over the cell we started on must not un-travel the gesture: the stroke has already
  // painted cells, and committing it as a tap would throw them away.
  if (t < 0 || t === stroke.anchor || stroke.items.some((it) => it.cell === t)) return;
  stroke.moved = true;
  preview(t, stroke.value);
  draw();
}

function strokeEnd() {
  if (!stroke || !game) return null;
  const s = stroke;
  stroke = null;
  const cells = s.items.map((it) => it.cell);
  // The stroke it is un-painting has already been detached from the module state above, so it has to
  // be handed over explicitly: `unpreview()` would read the now-null global and throw before the
  // gesture is committed — the ink stays on the board as a phantom that no 撤销 can take back.
  unpreview(s);
  if (!s.moved) {
    const step = game.tap(cells[0]);
    if (step) afterStep(step.value);
    else syncAll();
    return step;
  }
  const step = game.stroke(cells, s.value);
  if (!step) {
    syncAll();
    return null;
  }
  afterStep(s.value);
  return step;
}

el.canvas.addEventListener('pointerdown', strokeStart);
el.canvas.addEventListener('pointermove', strokeMove);
el.canvas.addEventListener('pointerup', strokeEnd);
el.canvas.addEventListener('pointercancel', () => {
  if (!stroke) return;
  unpreview();
  stroke = null;
  syncAll();
});
el.canvas.addEventListener('contextmenu', (ev) => ev.preventDefault());

$('#btn-mode-black').addEventListener('click', () => setMode(BLACK));
$('#btn-mode-white').addEventListener('click', () => setMode(WHITE));
$('#btn-mode-erase').addEventListener('click', () => setMode(UNKNOWN));
$('#btn-hint').addEventListener('click', useHint);
$('#btn-undo').addEventListener('click', undo);
$('#btn-new').addEventListener('click', () => begin({ tier: game ? game.puzzle.tier : TIERS[0].key }));
$('#btn-menu').addEventListener('click', () => {
  flushResume();
  show('menu');
});
$('#btn-menu-2').addEventListener('click', () => show('menu'));
$('#btn-again').addEventListener('click', () => begin({ tier: game ? game.puzzle.tier : TIERS[0].key }));
$('#btn-resume').addEventListener('click', () => {
  const r = Store.resume();
  // No origin seed means no way to rebuild *that* board — the generator is deterministic in its
  // seed, so resuming a save without one would paint old ink onto a different puzzle.
  if (!r || r.seed == null) return;
  begin({ tier: r.tier, seed: r.seed, resume: r });
});
$('#btn-sound').addEventListener('click', () => {
  Store.setSetting('sound', !Store.setting('sound'));
  applySettings();
  Sound.black();
});
$('#btn-motion').addEventListener('click', () => {
  Store.setSetting('reduceMotion', !Store.setting('reduceMotion'));
  applySettings();
});
$('#btn-reset').addEventListener('click', () => {
  Store.reset();
  applySettings();
  game = null;
  show('menu');
});

window.addEventListener('keydown', (ev) => {
  if (ev.target && /input|textarea/i.test(ev.target.tagName)) return;
  const k = ev.key.toLowerCase();
  if (k === 'h') useHint();
  else if (k === 'z') undo();
  else if (k === 'b') setMode(BLACK);
  else if (k === 'w') setMode(WHITE);
  else if (k === 'e') setMode(UNKNOWN);
  else if (/^[1-5]$/.test(k) && !el.viewMenu.hidden) begin({ tier: TIERS[Number(k) - 1].key });
});

window.addEventListener('resize', draw);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') flushResume();
});
window.addEventListener('pagehide', flushResume);

applyThemeVars();
applySettings();
renderMenu();

const surface = {
  version: VERSION,
  view,
  get game() {
    return game;
  },
  show,
  begin,
  useHint,
  undo,
  setMode,
  // The harness commits through the same paths a pointer release does, so a scenario that passes
  // here has driven the real state machine rather than a copy of it.
  stroke(cells, value) {
    if (!game) return null;
    const step = game.stroke(cells, value === undefined ? game.mode : value);
    if (step) afterStep(step.value);
    return step;
  },
  tap(t, value) {
    if (!game) return null;
    const step = value === undefined ? game.tap(t) : game.stroke([t], value);
    if (step) afterStep(step.value);
    else syncAll();
    return step;
  },
  solveWithLogic() {
    if (!game) return null;
    const r = game.solveWithLogic();
    syncAll();
    if (game.status === 'won') onWin();
    return r;
  },
  elapsed: clock,
  state: () => (game ? { ...game.state(), elapsedMs: clock() } : null),
  cellAt: (x, y) => (game ? game.cellAt(x, y) : -1),
  valueOf: (t) => (game ? game.valueOf(t) : UNKNOWN),
  valueName,
  hintLine,
  engine: {
    ...Engine,
    generate,
    // The generator's own legal-ink builder (js/engine/generate.js:41). It ships as part of the engine
    // module graph the surface documents as testable, and the browser-side 对照组 — delete clues from
    // a full clue board and see whether the counter and the pencil rules disagree — has to sample ink
    // from the same builder that makes every board this game ships. A second ink builder written
    // inside tools/scenarios.js would not be one: the shipped builder is what refuses 2×2 closures and
    // severed whites, and legal ink is the whole premise of that group.
    randomInk,
    puzzleFrom,
    defaultSeed,
    analyze,
    TIERS,
    tierFor,
    tierIndexFor,
    LIBRARY,
    byTier,
    Game,
    Store,
    theme: { ...Palette, ...Cell },
    BLACK,
    WHITE,
    UNKNOWN,
  },
};

// Two names for one object. `window.App` is the handle the round's brief asks for; `window.tapa` is
// the per-game namespace this family's browser harness drives (`window.slant` in the reference repo),
// so the verification台 written next round does not have to guess which one shipped.
window.App = surface;
window.tapa = surface;
