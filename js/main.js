// Wiring: DOM, pointer gestures, the clock, storage, and the `window.tapa` surface the verification
// harness drives. No rule about the board lives here — every judgement (what a cell may be, whether
// the board adds up, what a hint may say) comes from js/engine/tapa.js through js/ui/game.js.

import { Palette, Cell, Motion, applyThemeVars, setReduceMotion, systemPrefersReducedMotion } from './theme.js';
import { Sound } from './audio/synth.js';
import { Store } from './store.js';
import { TIERS, tierFor, tierIndexFor, generate, randomInk } from './engine/generate.js';
import { LIBRARY, byTier } from './data/library.js';
import { dayKey } from './engine/rng.js';
import * as Engine from './engine/tapa.js';
import { analyze } from './engine/count.js';
import { BoardView, pulsePhase } from './render/board.js';
import { InkFx } from './render/fx.js';
import { loadMotifs, onMotifsReady } from './render/assets.js';
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
  pauseVeil: $('#pause-veil'),
  winMeta: $('#win-meta'),
  winRecord: $('#win-record'),
  wrap: $('#board-wrap'),
  canvas: $('#board'),
};

const view = new BoardView(el.canvas);
const fx = new InkFx();
let game = null;
let pulse = null;
let stroke = null;
let pulseTimer = 0;
let startedAt = 0;
let baseElapsed = 0;

// 表现层时钟：单调、暂停照走，只管"现在几点"。对局计时是下面那个 clock()，暂停会停 ——
// 两者分开，一个动画才不会在暂停时替玩家继续跑。
const nowMs = () =>
  typeof performance === 'object' && performance && typeof performance.now === 'function'
    ? performance.now()
    : Date.now();

const clock = () => baseElapsed + (startedAt ? Date.now() - startedAt : 0);
const running = () => !!startedAt;

function fmtMs(ms) {
  const s = Math.floor(ms / 1000);
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

// ---- the presentation loop -------------------------------------------------
// 全仓唯一读帧间隔的地方，而且只当成"过了多少时间"来读 —— 模拟器把它花成整定步长。
// 没有任何一处位移乘这个 dt。
let rafId = 0;
let lastFrameAt = 0;
let frames = 0;

function loopWanted() {
  if (paused) return false;
  if (fx.active()) return true;
  if (pulse && pulsePhase(pulse, nowMs()) < 1) return true;
  return !!(game && running() && game.status !== 'won');
}

function startLoop() {
  if (rafId || paused) return;
  lastFrameAt = nowMs();
  rafId = requestAnimationFrame(frame);
}

function stopLoop() {
  if (!rafId) return;
  cancelAnimationFrame(rafId);
  rafId = 0;
}

function frame(now) {
  const dt = (now - lastFrameAt) / 1000;
  lastFrameAt = now;
  frames++;
  if (paused) {
    rafId = 0;
    return;
  }
  fx.advance(dt);
  if (game) {
    const t = fmtMs(clock());
    if (el.time.textContent !== t) el.time.textContent = t;
    if (pulse || fx.active()) draw();
  }
  if (loopWanted()) rafId = requestAnimationFrame(frame);
  else rafId = 0;
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
    fx,
    nowMs: nowMs(),
    preview: stroke && stroke.items.length ? { cells: stroke.items.map((i) => i.cell) } : null,
  });
  startLoop();
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
  // 这里只摆表，不碰 paused。以前它会顺手 paused = false，于是"解冻"有两条路：走 setPaused 的那条
  // 会重画按钮，直接调 startClock 的那条只把按钮留在「继续」上——盘面已经能画了，按钮却还写着继续，
  // 玩家按下去变成"再暂停一次"。冻 / 解冻归 paused 一个人管，解冻那一侧只有 adoptFreshBoard() 和
  // setPaused(false) 两处，它们都画按钮。
  startedAt = Date.now();
  startLoop();
}

function stopClock() {
  baseElapsed = clock();
  startedAt = 0;
}

// The brush a drag paints with. A tap still cycles, so the brush is only half the gesture story.
function setMode(value) {
  if (!game) return;
  if (blockedWhilePaused('换画笔')) return;
  game.mode = value;
  for (const [id, v] of [['#btn-mode-black', BLACK], ['#btn-mode-white', WHITE], ['#btn-mode-erase', UNKNOWN]]) {
    $(id).setAttribute('aria-pressed', String(v === value));
  }
  el.canvas.dataset.mode = value === BLACK ? 'black' : value === WHITE ? 'white' : 'erase';
  draw();
}

let paused = false;

// 暂停是真的停：计时冻住、笔落不下去、提示与撤销一起收掉。收笔之前先把这一笔的预览退回 ——
// 半截笔画留在盘上却没有 commit，那是 撤销 拿不回来的幽灵墨。
function paintPauseUi() {
  el.pauseVeil.hidden = !paused;
  const btn = $('#btn-pause');
  btn.textContent = paused ? '继续' : '暂停';
  btn.setAttribute('aria-pressed', String(paused));
}

function setPaused(next) {
  if (!game || game.status === 'won') return paused;
  const want = !!next;
  if (want === paused) return paused;
  // 先落状态再动副作用：解冻路径要 startClock → startLoop，而 startLoop 认 paused 拒绝重新排队。
  // 顺序反过来，继续 按下去只是把计时基准换了一下，帧循环再也起不来。
  paused = want;
  if (want) {
    // 一笔拖到半路被暂停：预览先擦回去（冻住的盘面不能挂着半截墨），但这一笔的骨架留着并记上
    // voided —— 指针松开那一步（release）才知道该作废哪一笔、该为哪一笔记账。在这里把 stroke
    // 置空，收笔路径就只剩一个"没有笔画"的空返回，这一刀永远点不上名。
    if (stroke) {
      unpreview();
      stroke.voided = true;
    }
    flushResume();
    stopClock();
    // 已经排队的下一帧也要收回：留着它，暂停后仍会烧掉一次 frame() 的空转。
    stopLoop();
  } else {
    startClock();
  }
  paintPauseUi();
  syncAll();
  return paused;
}

// 复位但不碰计时：换一局、回菜单、赢下这一局都走这里。那三处各自已经知道该 stop 还是 start，
// 暂停不该替它们决定。
function clearPause() {
  paused = false;
  paintPauseUi();
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
    pulse = { cell: info.cell, color: 'rgba(255,92,122,0.9)', t0: nowMs() };
    pulseTimer = setTimeout(() => {
      clearPulse();
      draw();
    }, Motion.pulse);
    Sound.conflict();
    return;
  }
  el.hintRule.textContent = `规则：${info.rule}`;
  el.hintLine.textContent = info.why;
  pulse = { cell: info.cell, clue: info.clue, slot: info.slot, t0: nowMs() };
  const mine = pulse;
  pulseTimer = setTimeout(() => {
    if (pulse === mine) {
      pulse = null;
      draw();
    }
  }, Motion.pulse);
  Sound.hint();
}

function onWin() {
  stopClock();
  clearPause();
  fx.celebrate(view.geo.w, view.geo.h);
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

// 一笔落地，墨点跟着溅起来。坐标取自 view.cellRect —— 和画布上那一格同源，所以缩放/换档
// 之后墨点不会落到邻居头上。长笔画只采三处：一次 30 格的横扫该溅几朵，不该溅 30 朵。
function spawnInk(step) {
  if (!step || !game) return;
  const writes = step.writes || (step.cell != null ? [{ cell: step.cell, to: step.value }] : []);
  if (!writes.length) return;
  const picks =
    writes.length <= 6 ? writes : [writes[0], writes[writes.length >> 1], writes[writes.length - 1]];
  for (const w of picks) {
    if (!w || w.cell == null || w.from === w.to) continue;
    const r = view.cellRect(w.cell);
    fx.splash(r.x + r.size / 2, r.y + r.size / 2, r.size, w.to == null ? step.value : w.to, 5);
  }
}

function afterStep(step) {
  spawnInk(step);
  syncAll();
  if (game.status === 'won') onWin();
  else {
    flushResume();
    const value = step && step.value !== undefined ? step.value : null;
    if (value !== null) Sound.place(value);
    if (game.stuck || game.violated.length) Sound.conflict();
  }
}

function useHint() {
  if (!game || game.status === 'won') return null;
  if (blockedWhilePaused('提示')) return null;
  const before = game.hints;
  const info = game.hint();
  if (!info) return null;
  // An unproductive hint is not a purchase: nothing was written, nothing is charged.
  if (info.stalled || info.conflict) {
    showHint(info);
    return info;
  }
  showHint(info);
  if (game.hints !== before) afterStep(info);
  return info;
}

function undo() {
  if (!game) return null;
  if (blockedWhilePaused('撤销')) return null;
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
  fx.reset();
  stroke = null;
  el.winVeil.hidden = true;
  adoptFreshBoard();
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
    clearPause();
    stopClock();
    fx.reset();
    stopLoop();
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
  // paused 也要算"还在屏幕上活着"：暂停把 startedAt 清零了，只问 running() 会让菜单在
  // 玩家暂停的那一刻起，把同一局当成一份可以重开的存档推给他。
  const live = game && game.status !== 'won' && (running() || paused);
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
  fx.setEnabled(!reduce);
  $('#btn-sound').setAttribute('aria-pressed', String(!!Store.setting('sound')));
  $('#btn-sound').textContent = Store.setting('sound') ? '音效 开' : '音效 关';
  $('#btn-motion').setAttribute('aria-pressed', String(!!Store.setting('reduceMotion')));
  $('#btn-motion').textContent = reduce ? '动效 省' : '动效 全';
}

function toggleSound() {
  Store.setSetting('sound', !Store.setting('sound'));
  applySettings();
  // 确认音只在还开着的时候敲：关着还能敲出声，那个开关就是假的。
  if (!Sound.muted()) Sound.black();
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

// 一次落笔的语义只写一遍：press 命中格子才开一笔，drag 只吃没画过的格，release 收笔并落账。
// 指针、触摸、鼠标三种入口都汇到这里，否则三套手势会各自漂移出一套"点 A 打 B"的历史。
function press(clientX, clientY, button) {
  if (!game || game.status === 'won' || paused) return false;
  const t = view.hitCell(clientX, clientY);
  if (t < 0) return false;
  clearPulse();
  // The right-button gesture is the eraser: sweeping over your own ink to clear it is the one thing
  // a player reaches for before 撤销.
  const value = button === 2 ? UNKNOWN : game.mode;
  stroke = { items: [], value, anchor: t, moved: false };
  preview(t, value);
  draw();
  return true;
}

function drag(clientX, clientY) {
  if (!stroke || !game || stroke.voided) return;
  const t = view.hitCell(clientX, clientY);
  // Sweeping back over the cell we started on must not un-travel the gesture: the stroke has already
  // painted cells, and committing it as a tap would throw them away.
  if (t < 0 || t === stroke.anchor || stroke.items.some((it) => it.cell === t)) return;
  stroke.moved = true;
  preview(t, stroke.value);
  draw();
}

function release() {
  if (!stroke || !game) return null;
  const s = stroke;
  stroke = null;
  // 拖到一半被暂停（一只手压着鼠标、另一只手按 P 是真做得到的一件事）：这一笔整个作废，
  // 预览擦回去之后不提交 —— 冻住的盘面不能因为"手势开始于解冻时"就从缝里收下这一笔。
  if (paused || s.voided) {
    unpreview(s);
    if (paused) blockedWhilePaused('拖到一半的那一笔');
    return null;
  }
  const cells = s.items.map((it) => it.cell);
  // The stroke it is un-painting has already been detached from the module state above, so it has to
  // be handed over explicitly: `unpreview()` would read the now-null global and throw before the
  // gesture is committed — the ink stays on the board as a phantom that no 撤销 can take back.
  unpreview(s);
  if (!s.moved) {
    const step = game.tap(cells[0]);
    if (step) afterStep(step);
    else syncAll();
    return step;
  }
  const step = game.stroke(cells, s.value);
  if (!step) {
    syncAll();
    return null;
  }
  afterStep(step);
  return step;
}

function cancelStroke() {
  if (!stroke) return;
  unpreview();
  stroke = null;
  syncAll();
}

function strokeStart(ev) {
  if (!game || game.status === 'won') return;
  if (view.hitCell(ev.clientX, ev.clientY) < 0) return;
  ev.preventDefault();
  if (blockedWhilePaused('这一笔')) return;
  if (!press(ev.clientX, ev.clientY, ev.button)) return;
  el.canvas.setPointerCapture?.(ev.pointerId);
}

function strokeMove(ev) {
  drag(ev.clientX, ev.clientY);
}

function strokeEnd() {
  return release();
}

// `touch-action: none` 已经在 css 上把滚动/双击缩放让给画布了；这里只负责把点转成手势。
el.canvas.addEventListener('pointerdown', strokeStart);
el.canvas.addEventListener('pointermove', strokeMove);
el.canvas.addEventListener('pointerup', strokeEnd);
el.canvas.addEventListener('pointercancel', cancelStroke);
el.canvas.addEventListener('contextmenu', (ev) => ev.preventDefault());

// 回落：PointerEvent 缺席的环境（老 WebKit、无 polyfill 的旧安卓浏览器）里 `pointer*` 一支都
// 不会触发，只有 pointerdown 的画布就是一块砖。这一支必须存在，但**只在没有 PointerEvent 时**
// 注册 —— 两边都挂会把同一次触摸处理两遍（一笔变成两步，撤销也退不干净）。
const hasPointer = typeof window !== 'undefined' && typeof window.PointerEvent === 'function';
if (!hasPointer) {
  const point = (ev) => (ev.touches && ev.touches.length ? ev.touches[0] : (ev.changedTouches || [])[0]) || ev;
  let touchLive = false;
  el.canvas.addEventListener(
    'touchstart',
    (ev) => {
      const p = point(ev);
      if (!p) return;
      if (!press(p.clientX, p.clientY, 0)) return;
      touchLive = true;
      ev.preventDefault();
    },
    { passive: false }
  );
  el.canvas.addEventListener(
    'touchmove',
    (ev) => {
      if (!touchLive) return;
      const p = point(ev);
      if (p) drag(p.clientX, p.clientY);
      ev.preventDefault();
    },
    { passive: false }
  );
  const touchFinish = (ev) => {
    if (!touchLive) return;
    touchLive = false;
    if (ev && ev.cancelable) ev.preventDefault();
    release();
  };
  el.canvas.addEventListener('touchend', touchFinish);
  el.canvas.addEventListener('touchcancel', () => {
    touchLive = false;
    cancelStroke();
  });
  // 鼠标回落给的是同一套 press/drag/release：右键当橡皮，和指针那条路径一字不差。
  let mouseLive = false;
  el.canvas.addEventListener('mousedown', (ev) => {
    if (!press(ev.clientX, ev.clientY, ev.button)) return;
    mouseLive = true;
    ev.preventDefault();
  });
  el.canvas.addEventListener('mousemove', (ev) => {
    if (mouseLive) drag(ev.clientX, ev.clientY);
  });
  window.addEventListener('mouseup', () => {
    if (!mouseLive) return;
    mouseLive = false;
    release();
  });
}

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
$('#btn-pause').addEventListener('click', () => setPaused(!paused));
$('#btn-unpause').addEventListener('click', () => setPaused(false));
$('#btn-fullscreen').addEventListener('click', toggleFullscreen);
document.addEventListener('fullscreenchange', syncFullButton);
document.addEventListener('webkitfullscreenchange', syncFullButton);
document.addEventListener('MSFullscreenChange', syncFullButton);
$('#btn-resume').addEventListener('click', () => {
  const r = Store.resume();
  // No origin seed means no way to rebuild *that* board — the generator is deterministic in its
  // seed, so resuming a save without one would paint old ink onto a different puzzle.
  if (!r || r.seed == null) return;
  begin({ tier: r.tier, seed: r.seed, resume: r });
});
$('#btn-sound').addEventListener('click', toggleSound);
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

// 玩法一句话说明就写在提示面板里 —— 那是这一局唯一的"当前该看哪"的地方，另开一个浮层只会
// 让人先学会关浮层。
const TEACHING =
  '点一格：未知 → 黑 → 白。按住拖：用当前画笔连染一片，右 drag 是橡皮。数字写在它数的那个方向的边上，顺时针读，数的是那个方向上连续的墨段；三个 0 的环是说这格四周全白。';

window.addEventListener('keydown', (ev) => {
  if (ev.target && /input|textarea/i.test(ev.target.tagName)) return;
  const k = ev.key.toLowerCase();
  const onMenu = !el.viewMenu.hidden;
  // 菜单里 Enter / 空格就是"开一局"。键盘玩家没有鼠标也必须进得了关，这一条比快捷键表上
  // 其它所有条都优先。
  if (onMenu && (k === 'enter' || k === ' ')) {
    ev.preventDefault();
    begin({ tier: TIERS[0].key });
    return;
  }
  // 全屏与静音是系统级开关：暂停着也得按得动，否则"暂停"把玩家的显示器和耳朵一起锁住了。
  if (k === 'f') {
    ev.preventDefault();
    toggleFullscreen();
    return;
  }
  if (k === 'm') {
    ev.preventDefault();
    toggleSound();
    return;
  }
  if (k === '?' || (k === '/' && ev.shiftKey)) {
    ev.preventDefault();
    el.hintRule.textContent = '玩法';
    el.hintLine.textContent = TEACHING;
    return;
  }
  // 暂停时只有 P / 空格负责解冻。空格不能抢焦点按钮的原生激活：焦点在按钮上时让给它自己。
  if (k === 'p' || (k === ' ' && ev.target && ev.target.tagName !== 'BUTTON')) {
    ev.preventDefault();
    setPaused(!paused);
    return;
  }
  // 五条玩法键先走各自的写手，闸装在那里：暂停时按 H 也要拿到一句"提示没有落地"，
  // 而不是整条 listener 提前 return 让玩家以为键盘坏了。
  if (k === 'h') useHint();
  else if (k === 'z') undo();
  else if (k === 'b') setMode(BLACK);
  else if (k === 'w') setMode(WHITE);
  else if (k === 'e') setMode(UNKNOWN);
  else {
    if (paused) return;
    if (k === 'r') {
      if (!game) return;
      ev.preventDefault();
      begin({ tier: game.puzzle.tier });
    } else if (k === 'enter' && game && game.status === 'won') {
      ev.preventDefault();
      begin({ tier: game.puzzle.tier });
    } else if (/^[1-5]$/.test(k) && onMenu) begin({ tier: TIERS[Number(k) - 1].key });
  }
});

window.addEventListener('resize', draw);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') flushResume();
});
window.addEventListener('pagehide', flushResume);

applyThemeVars();
applySettings();
// 贴图解码完成往往晚于第一帧：不重画的话，纸纹/墨点/环这三张母题要等玩家下一次落墨才出现。
onMotifsReady(() => {
  if (game) draw();
});
loadMotifs();
renderMenu();

// manifest 的 shortcut 写着 ./?resume=1，这条 URL 于是不能只把人送回菜单：广告一个入口
// 而它落在别处，比不给入口更糟。走的是 #btn-resume 同一条 begin() 路径；没有存档时安静地
// 留在菜单 —— 从桌面图标点进来的人不该先看到一个异常。
{
  const params = new URLSearchParams(location.search);
  const r = params.get('resume') === '1' ? Store.resume() : null;
  if (r) begin({ tier: r.tier, seed: r.seed, resume: r });
}

const surface = {
  version: VERSION,
  view,
  get game() {
    return game;
  },
  show,
  begin,
  get paused() {
    return paused;
  },
  setPaused,
  toggleFullscreen,
  useHint,
  undo,
  setMode,
  // The harness commits through the same paths a pointer release does, so a scenario that passes
  // here has driven the real state machine rather than a copy of it. That only holds if the gate is
  // the same gate: `press()` refuses to open a stroke while 暂停, so these two must refuse too —
  // otherwise a browser scenario can paint over a paused board and still report 暂停 生效.
  stroke(cells, value) {
    if (!game) return null;
    if (blockedWhilePaused('台面那一笔')) return null;
    const step = game.stroke(cells, value === undefined ? game.mode : value);
    if (step) afterStep(step);
    return step;
  },
  tap(t, value) {
    if (!game) return null;
    if (blockedWhilePaused('台面那一格')) return null;
    const step = value === undefined ? game.tap(t) : game.stroke([t], value);
    if (step) afterStep(step);
    else syncAll();
    return step;
  },
  solveWithLogic() {
    if (!game) return null;
    // 台面这三条写入路绕过了 pointer 与按钮，浏览器腿点不到玩家点不到的东西，却调得到它们。
    // 冻盘要挡的是"盘面被改"这件事本身，所以闸得装在离状态机最近的地方，而不是只装在控件后面。
    if (blockedWhilePaused('台面推演')) return null;
    const r = game.solveWithLogic();
    syncAll();
    if (game.status === 'won') onWin();
    return r;
  },
  elapsed: clock,
  state: () => (game ? { ...game.state(), elapsedMs: clock(), paused } : null),
  blocked: () => ({ ...blocked }),
  // 表现层也得能被读到：只挂引擎账本的对拍会把"动画根本没时间轴"当成三档全等。
  fx: () => fx.state(),
  anim: () => ({
    frames,
    rafOn: !!rafId,
    clockMs: nowMs(),
    lastFrameAt,
    pulsePhase: pulse ? pulsePhase(pulse, nowMs()) : null,
  }),
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

// 全屏要真发请求，也要真读回状态：系统拒绝、浏览器不支持、玩家按 Esc 退出，按钮都得跟着改字
// —— "按钮写着全屏而屏幕没全屏"就是假开关。
function fullscreenElement() {
  return document.fullscreenElement || document.webkitFullscreenElement || document.msFullscreenElement || null;
}

function toggleFullscreen() {
  const host = document.documentElement;
  const current = fullscreenElement();
  if (current) {
    const exit = document.exitFullscreen || document.webkitExitFullscreen || document.msExitFullscreen;
    exit?.call(document)?.catch?.(() => {});
    return false;
  }
  const req = host.requestFullscreen || host.webkitRequestFullscreen || host.msRequestFullscreen;
  if (!req) return false;
  req.call(host)?.catch?.(() => {});
  return true;
}

function syncFullButton() {
  const on = !!fullscreenElement();
  const btn = $('#btn-fullscreen');
  btn.textContent = on ? '退出全屏' : '全屏';
  btn.setAttribute('aria-pressed', String(on));
  btn.title = '全屏（F）';
  document.body.classList.toggle('fullscreen', on);
}

// Two names for one object. `window.App` is the handle the round's brief asks for; `window.tapa` is
// the per-game namespace this family's browser harness drives (`window.slant` in the reference repo),
// so the verification台 written next round does not have to guess which one shipped.
window.App = surface;
window.tapa = surface;

// ---- 暂停：冻住的是两样东西，时钟和盘面 ----
//
// 只停表不停盘，暂停就是一段免费的思考时间：本仓的纪录同档先比提示次数、再比步数、最后才比 `ms`
// （js/store.js:157-164 `recordBest`），而 `#stat-time` 那一格是从同一个 `clock()` 读出来的。
// 按下暂停、慢慢想、想完按继续再一路画到赢，落进存档的是扣掉了思考时间的 `ms`——榜上那个数
// 就不再是玩家花掉的时间。所以这里必须两件事都做到：
// ① 停表：setPaused(true) 调 stopClock()——baseElapsed 落账、startedAt 归 0、ticker 停，
//    此后 clock() 恒等于 baseElapsed，墙钟再走多久也加不上去。
// setPaused(false) 调 startClock()：startedAt 复位成"从现在起"，
// 所以恢复后的第一帧不会把暂停期间憋下的墙钟一次性灌进来（没有 dt 尖峰）。
// ② 冻盘：闸装在写手身上（blockedWhilePaused），不装在输入设备上 —— 这一笔 / 拖到一半的那一笔 /
//    撤销 / 提示 / 换画笔，以及台面直接改盘的 stroke·tap·solveWithLogic 三条，每一个写盘的动作都先
//    退回再动手。键盘那一路（H/Z/B/W/E，js/main.js:509 那个 listener）本来就走的就是这几个函数，
//    所以它继承同一把闸，并且和按钮一样得到一句解释；如果在 listener 上整体挡掉，玩家按下 H 会什么
//    反馈都拿不到。数字键 1-5 不在玩法里而在选档页（js/main.js:517 的 !el.viewMenu.hidden），它起的是
//    新局：begin() 自己解冻、自己把表归零，记的是这块新盘真实花掉的时间，所以它不带一把闸。
//    挡下来的原因写进 #state-line，不是把控件弄灰：弄灰的按钮玩家按下去得不到任何解释。
//
/** 新局接手盘面时才解冻：冻解除、表针归零、按钮跟着画对。
 *
 * 它必须排在 begin() 里 `if (!puzzle) return null` 那条出口**之后**：那条出口屏幕上还是上一局那块盘，
 * 抹它的表和它的冻等于给旧盘解冻并把表清零，赢下去记的是一个偏小的 ms——而 ms 正是纪录的最后一个
 * 比较位（js/store.js:157-164）。dosun 这一轮就踩过：重置写在 begin() 头上，浏览器腿全绿。
 * 解冻又必须排在 setMode(BLACK) / startClock() 之前：冻着的盘会把新局的默认画笔挡在闸外，
 * 状态行谎报"换画笔没有落地"，按钮还停在「继续」。 */
function adoptFreshBoard() {
  clearPause();
  baseElapsed = 0;
}

// 每一次被挡下来的操作都记账：闸要的正是"这一刀确实撞在墙上并被点名"，而不是"界面看起来没动"。
// 只数这一轮真被挡的（paused 为假时返回 false，什么都不写），所以它不会把正常操作也算成挡刀。
var blocked = { count: 0, last: '' };
function blockedWhilePaused(what) {
  if (!paused) return false;
  blocked.count++;
  blocked.last = what;
  syncAll();
  el.stateLine.textContent = `已暂停：${what}没有落地。暂停冻住表针，也冻住盘面 —— 按「继续」(P 或空格) 再继续。`;
  return true;
}
