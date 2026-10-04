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
  // 这里只摆表，不碰 paused。以前它会顺手 paused = false，于是"解冻"有两条路：走 setPaused 的那条
  // 会重画按钮，直接调 startClock 的那条只把按钮留在「继续」上——盘面已经能画了，按钮却还写着继续，
  // 玩家按下去变成"再暂停一次"。冻 / 解冻归 paused 一个人管，解冻那一侧只有 adoptFreshBoard() 和
  // setPaused(false) 两处，它们都画按钮。
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
  if (blockedWhilePaused('换画笔')) return;
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
  if (game.hints !== before) afterStep(info.value);
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
  stroke = null;
  el.winVeil.hidden = true;
  // 解冻必须排在下面那些写手之前，而且排在这条 `if (!puzzle) return null` 之后（见本函数第二行）：
  // 上一局的 paused 如果留着，新盘的默认画笔 setMode(BLACK) 会被冻盘那条闸挡掉，状态行还要谎报
  // "换画笔没有落地"；按钮也继续写着「继续」，玩家看到的是一把解不开的死锁。放在"不起新局"那条
  // 出口之后，是因为那条出口屏幕上还是上一局那块盘——抹它的表和它的冻，等于给旧盘解冻并把表清零。
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
  // 挡在命中之后：只有真按到格子的一刀才被记成一笔挡刀，按在棋盘外不谎报。
  if (blockedWhilePaused('这一笔')) return;
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
  // 拖到一半被暂停（一只手压着鼠标、另一只手按 P 是真做得到的一件事）：这一笔整个作废，
  // 预览擦回去之后不提交 —— 冻住的盘面不能因为"手势开始于解冻时"就从缝里收下这一笔。
  if (paused) {
    unpreview(s);
    blockedWhilePaused('拖到一半的那一笔');
    return null;
  }
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
    if (blockedWhilePaused('台面那一笔')) return null;
    const step = game.stroke(cells, value === undefined ? game.mode : value);
    if (step) afterStep(step.value);
    return step;
  },
  tap(t, value) {
    if (!game) return null;
    if (blockedWhilePaused('台面那一格')) return null;
    const step = value === undefined ? game.tap(t) : game.stroke([t], value);
    if (step) afterStep(step.value);
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
  paused: isPaused,
  setPaused,
  togglePause,
  // 闸要把"每一刀都被点名"当成证据读，所以它得能被外面数到：count 是这一页活到现在挡下的刀数。
  blocked: () => ({ count: blocked.count, last: blocked.last }),
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

// ---- 全屏开关（#btn-fullscreen）----
// 绑的是本页 HUD 上真实存在的那个按钮。全屏最常见的假实现就是引用一个并不存在的
// id：点下去什么也不会发生，量具却算它"已实现"。所以这里找不到按钮就直接不装。
(function bindFullscreen() {
  const btn = document.getElementById('btn-fullscreen');
  if (!btn) return;
  const root = document.documentElement;
  // 只做特性检测，不嗅探 UA：iOS Safari 是 webkitRequestFullscreen，老 Edge 是 ms 前缀，
  // 而 UA 字符串随时会改。"有没有这个能力"是查出来的，不是猜出来的。
  const req = root.requestFullscreen || root.webkitRequestFullscreen || root.msRequestFullscreen;
  const exit = document.exitFullscreen || document.webkitExitFullscreen || document.msExitFullscreen;
  const current = () => document.fullscreenElement || document.webkitFullscreenElement
    || document.msFullscreenElement || null;

  // 不支持也要给个说法：只把按钮灰掉而不解释，玩家会以为这功能没做完。
  // supported 这枚标记不能省：下面 sync() 每次都会重写 title，不挡住的话，装的时候刚写
  // 进去的人话原因会被随后的 sync() 立刻抹成"全屏 (F)"——禁用就变成一句没有理由的禁用。
  let supported = !!req;
  const unsupported = () => {
    supported = false;
    btn.disabled = true;
    btn.title = '这个浏览器不提供元素全屏（iOS Safari 请用「添加到主屏幕」独立打开）';
  };
  if (!req) unsupported();

  // fullscreen 返回 Promise，被拒时必须吃掉：iOS Safari 对多数非 video 元素直接拒绝，
  // 让这个 rejection 冒泡出去会变成一条未捕获错误，整局游戏跟着挂。
  const settle = (p) => { if (p && p.catch) p.catch(unsupported); };

  // 进出都能走：已经全屏时这次调用是退出，不是"再进一次"。
  function toggle() {
    try {
      if (current()) {
        if (exit) settle(exit.call(document));
      } else if (req) {
        settle(req.call(root));
      } else {
        unsupported();
      }
    } catch (e) {
      unsupported();
    }
  }

  // Esc 和系统手势退出都不经过我们的代码，按钮状态只能靠 fullscreenchange 回写，
  // 否则用户已经退出、HUD 还停在"退出全屏"，下一次点击反而会重新进全屏。
  function sync() {
    const on = !!current();
    btn.setAttribute('aria-pressed', String(on));
    btn.textContent = on ? "退出全屏" : "全屏";
    if (supported) btn.title = "全屏" + '（F）';
    const body = document.body;
    if (body && body.classList) body.classList.toggle('fullscreen', on);
  }

  btn.addEventListener('click', toggle);
  window.addEventListener('keydown', (ev) => {
    if (ev.key !== 'f' && ev.key !== 'F') return;
    const t = ev.target;
    // 盘号 / 种子这类输入框里打字不能触发全屏，否则玩家输 seed 输到一半屏幕没了。
    if (t && /input|textarea|select/i.test(t.tagName || '')) return;
    if (ev.repeat || ev.metaKey || ev.ctrlKey || ev.altKey) return;
    ev.preventDefault();
    toggle();
  });
  window.addEventListener('fullscreenchange', sync);
  window.addEventListener('webkitfullscreenchange', sync);
  window.addEventListener('MSFullscreenChange', sync);
  sync();
})();

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
// 用 var 而不是 let：本块在文件末尾，而 startClock() 可能在它之前就被 begin() 调过；
// let 声明提升不到初始化，TDZ 会直接抛 ReferenceError。
var paused = false;
function paintPauseButton() {
  var b = document.getElementById('btn-pause');
  if (!b) return;
  b.setAttribute('aria-pressed', String(paused));
  b.textContent = paused ? '继续' : '暂停';
  b.title = paused ? '继续 (P)' : '暂停 (P)';
}
function setPaused(v) {
  v = !!v;
  if (v === paused) return paused;
  if (v) stopClock(); else startClock();
  paused = v;
  paintPauseButton();
  return paused;
}
function togglePause() { return setPaused(!paused); }
function isPaused() { return paused; }

/** 新局接手盘面时才解冻：冻解除、表针归零、按钮跟着画对。
 *
 * 它必须排在 begin() 里 `if (!puzzle) return null` 那条出口**之后**：那条出口屏幕上还是上一局那块盘，
 * 抹它的表和它的冻等于给旧盘解冻并把表清零，赢下去记的是一个偏小的 ms——而 ms 正是纪录的最后一个
 * 比较位（js/store.js:157-164）。dosun 这一轮就踩过：重置写在 begin() 头上，浏览器腿全绿。
 * 解冻又必须排在 setMode(BLACK) / startClock() 之前：冻着的盘会把新局的默认画笔挡在闸外，
 * 状态行谎报"换画笔没有落地"，按钮还停在「继续」。 */
function adoptFreshBoard() {
  paused = false;
  baseElapsed = 0;
  paintPauseButton();
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

document.getElementById('btn-pause').addEventListener('click', togglePause);
window.addEventListener('keydown', function (ev) {
  if (ev.metaKey || ev.ctrlKey || ev.altKey) return;
  if (ev.target && /input|textarea|select/i.test(ev.target.tagName)) return;
  var k = ev.key;
  if (k === 'p' || k === 'P' || k === ' ') { ev.preventDefault(); togglePause(); }
});

// ---- 静音开关（M）-----------------------------------------------------------------
// M 键切静音，与全屏/重开/提示同一套键位。
// 这里只负责把按键翻译成"点一下音效按钮"：真静音在 js/audio/synth.js 里做
// （suspend AudioContext + 静音态不再新建振荡器节点），偏好由它落盘到 localStorage。
window.addEventListener('keydown', (ev) => {
  if (ev.metaKey || ev.ctrlKey || ev.altKey) return;
  if (ev.target && /^(input|textarea|select)$/i.test(ev.target.tagName || '')) return;
  if (ev.key === 'm' || ev.key === 'M') {
    ev.preventDefault();
    $('#btn-sound').click();
  }
});
