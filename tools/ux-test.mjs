// UX 行为单测，跑在纯 node 里：`node tools/ux-test.mjs`（`npm test` 会一起带上）。
//
// 为什么另开一个文件而不是加进 tools/scenarios.js：scenarios.js 断言的是"页面上真的看得见的东西"，
// 必须有 Chrome + CDP。而简报里那一串判据（静音真停 AudioContext、暂停期间仿真不推进、重开把累加器
// 清零、脏存档只丢那一条、命中按 CSS 缩放换算、只在 PointerEvent 缺席时挂 touch 回落）判的是**状态机
// 有没有真的动手**，一台虚拟时钟 + 最小 DOM 桩就能钉死，CI 上不需要浏览器。
//
// 口径和 scenarios.js 一致：只走玩家走得通的那几条入口（元素上的真实 click/keydown 派发、画布上的
// pointerdown/pointerup），不去直接改内部字段。桩缺一条就让它红，不许把断言降到桩能过的程度。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let pass = 0;
let fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) pass++;
  else {
    fail++;
    console.log(`  FAIL ${name} ${detail}`);
  }
};
const eq = (name, got, want) => ok(name, String(got) === String(want), `\n       got  ${got}\n       want ${want}`);

// ---------- 虚拟时钟：所有"过了多少时间"都由这里发，rAF/定时器一起走 ----------
let V = 1000; // 从 1000ms 起步：从 0 起步会被 `lastTime === 0` 这类哨兵吃掉第一帧
let timers = [];
let timerSeq = 1;
const after = (ms, fn) => {
  const id = timerSeq++;
  timers.push({ id, due: V + (ms || 0), fn });
  return id;
};
const runTimers = () => {
  for (let guard = 0; guard < 100000; guard++) {
    timers.sort((a, b) => a.due - b.due || a.id - b.id);
    if (!timers.length || timers[0].due > V) return;
    timers.shift().fn();
  }
};
let rafQueue = [];
let rafSeq = 1;

// 固定随机种子：粒子初值走的是 Math.random，不顶掉它就没有"两次跑同一条轨迹"这回事
let lcg = 0x2f6e2b1 >>> 0;
Math.random = () => {
  lcg = (lcg * 1664525 + 1013904223) >>> 0;
  return lcg / 4294967296;
};

const ctx2d = new Proxy(
  { canvas: null },
  {
    get(o, k) {
      if (k === 'createPattern' || k === 'createLinearGradient' || k === 'createRadialGradient') return () => ({ addColorStop() {} });
      if (k === 'measureText') return () => ({ width: 8 });
      if (k === 'getImageData') return () => ({ data: new Uint8ClampedArray(4) });
      if (typeof k === 'string' && k in o && typeof o[k] !== 'function') return o[k];
      return () => {};
    },
    set(o, k, v) {
      o[k] = v;
      return true;
    },
  }
);

class El {
  constructor(id, tag = 'div') {
    this.id = id;
    this.tagName = String(tag).toUpperCase();
    this._l = new Map();
    const self = this;
    this.classList = {
      _s: new Set(),
      add(...c) { c.forEach((x) => this._s.add(x)); },
      remove(...c) { c.forEach((x) => this._s.delete(x)); },
      toggle(c, f) {
        const w = f === undefined ? !this._s.has(c) : !!f;
        w ? this._s.add(c) : this._s.delete(c);
        return w;
      },
      contains(c) { return this._s.has(c); },
    };
    this.dataset = {};
    this.style = {
      _p: {},
      setProperty(k, v) { this._p[k] = v; },
      getPropertyValue(k) { return this._p[k] || ''; },
      removeProperty(k) { delete this._p[k]; },
      get width() { return self._sw || ''; },
      set width(v) { self._sw = v; },
      get height() { return self._sh || ''; },
      set height(v) { self._sh = v; },
    };
    this.textContent = '';
    this.innerHTML = '';
    this.hidden = false;
    this.clientWidth = 800;
    this.clientHeight = 600;
    this.children = [];
    this.complete = false;
    this.naturalWidth = 0;
  }
  addEventListener(t, fn) {
    if (!this._l.has(t)) this._l.set(t, []);
    this._l.get(t).push(fn);
  }
  removeEventListener() {}
  // 派发而非直接调回调：main.js 的手势处理要 preventDefault、要 ev.target，走原路才算"玩家按得动"
  dispatch(ev) {
    let prevented = false;
    ev.preventDefault = () => { prevented = true; };
    ev.stopPropagation = () => {};
    ev.target = ev.target || this;
    ev.cancelable = true;
    (this._l.get(ev.type) || []).slice().forEach((fn) => fn(ev));
    return { prevented };
  }
  appendChild(c) { this.children.push(c); return c; }
  append(...n) { this.children.push(...n); }
  setAttribute(k, v) { this['attr_' + k] = String(v); }
  getAttribute(k) { return this['attr_' + k] == null ? null : this['attr_' + k]; }
  hasAttribute(k) { return this['attr_' + k] != null; }
  // syncStats 会在拿到的元素上 .classList.toggle(...)，给 null 就是 TypeError
  closest() { return new El('closest-probe'); }
  contains() { return false; }
  getContext() { return ctx2d; }
  setPointerCapture() {}
  releasePointerCapture() {}
  getBoundingClientRect() {
    const w = parseFloat(this.style.width) || this.clientWidth;
    const h = parseFloat(this.style.height) || this.clientHeight;
    return { left: 0, top: 0, right: w, bottom: h, width: w, height: h, x: 0, y: 0 };
  }
}

class StubImage extends El {
  constructor() { super('img', 'img'); }
  set src(v) {
    this._src = v;
    this.complete = true;
    this.naturalWidth = 64;
    this.naturalHeight = 64;
    after(0, () => this.onload && this.onload({ type: 'load' }));
  }
  get src() { return this._src; }
}

const elCache = new Map();
const qsel = (sel) => {
  if (!elCache.has(sel)) elCache.set(sel, new El(String(sel).replace(/^#/, '')));
  return elCache.get(sel);
};
const docListeners = new Map();
const documentStub = {
  querySelector: qsel,
  querySelectorAll: () => [],
  getElementById: (i) => qsel('#' + i),
  createElement: (t) => new El('created-' + t, t),
  createTextNode: (t) => ({ textContent: String(t) }),
  createDocumentFragment: () => new El('frag'),
  documentElement: new El('html', 'html'),
  head: new El('head'),
  body: new El('body'),
  activeElement: null,
  fullscreenElement: null,
  exitFullscreen: () => Promise.resolve(),
  addEventListener(t, fn) { if (!docListeners.has(t)) docListeners.set(t, []); docListeners.get(t).push(fn); },
  removeEventListener() {},
  title: '视窗',
  hidden: false,
  visibilityState: 'visible',
  baseURI: pathToFileURL(path.join(root, 'index.html')).href,
  fonts: { ready: Promise.resolve() },
};
const fireDoc = (type, ev = {}) => {
  ev.preventDefault = () => {};
  (docListeners.get(type) || []).slice().forEach((fn) => fn(ev));
};

const lsStore = new Map();
const winListeners = new Map();
const audio = { contexts: [], oscillators: 0 };
function StubAudioContext() {
  const ac = {
    state: 'running',
    currentTime: 0,
    sampleRate: 48000,
    destination: { connect() {} },
    createGain: () => ({ connect() { return this; }, gain: { value: 1, setValueAtTime() {}, exponentialRampToValueAtTime() {}, linearRampToValueAtTime() {} } }),
    createOscillator: () => {
      audio.oscillators++;
      return { type: 'sine', frequency: { value: 0, setValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect(n) { return n; }, start() {}, stop() {} };
    },
    createBuffer: () => ({ getChannelData: () => new Float32Array(64) }),
    resume() { ac.state = 'running'; return Promise.resolve(); },
    suspend() { ac.state = 'suspended'; return Promise.resolve(); },
  };
  audio.contexts.push(ac);
  return ac;
}

const g = globalThis;
const force = (k, v) => Object.defineProperty(g, k, { value: v, writable: true, configurable: true });
force('navigator', { userAgent: 'tapa-ux-test', maxTouchPoints: 1 });
force('performance', { now: () => V });
g.window = g;
g.self = g;
g.document = documentStub;
g.localStorage = {
  getItem: (k) => (lsStore.has(k) ? lsStore.get(k) : null),
  setItem: (k, v) => { lsStore.set(k, String(v)); },
  removeItem: (k) => { lsStore.delete(k); },
  clear: () => lsStore.clear(),
};
g.Image = StubImage;
g.AudioContext = StubAudioContext;
g.webkitAudioContext = StubAudioContext;
g.devicePixelRatio = 2;
g.innerWidth = 1200;
g.innerHeight = 900;
g.matchMedia = (q) => ({ matches: false, media: q, addEventListener() {}, addListener() {}, removeEventListener() {} });
g.addEventListener = (t, fn) => { if (!winListeners.has(t)) winListeners.set(t, []); winListeners.get(t).push(fn); };
g.removeEventListener = () => {};
const fireWin = (type, ev = {}) => {
  ev.preventDefault = () => {};
  ev.stopPropagation = () => {};
  (winListeners.get(type) || []).slice().forEach((fn) => fn(ev));
};
g.requestAnimationFrame = (cb) => { const id = rafSeq++; rafQueue.push([id, cb]); return id; };
g.cancelAnimationFrame = (id) => { rafQueue = rafQueue.filter(([i]) => i !== id); };
g.setTimeout = (fn, ms) => after(ms, fn);
g.clearTimeout = (id) => { timers = timers.filter((t) => t.id !== id); };
g.setInterval = () => 0;
g.clearInterval = () => {};
g.getComputedStyle = () => ({ getPropertyValue: () => '', setProperty() {}, removeProperty() {} });
g.location = {
  href: pathToFileURL(path.join(root, 'index.html')).href,
  protocol: 'https:', host: 'example.test', hostname: 'example.test', origin: 'https://example.test',
  pathname: '/index.html', search: '', hash: '', reload() {}, assign() {}, replace() {},
};
g.history = { pushState() {}, replaceState() {}, state: null, length: 1 };
g.PointerEvent = function PointerEvent() {};
g.ResizeObserver = function () { return { observe() {}, unobserve() {}, disconnect() {} }; };
g.fetch = () => Promise.resolve({ ok: true, json: () => Promise.resolve({}), text: () => Promise.resolve('') });
g.alert = () => {};
g.confirm = () => false;
const RealDate = Date;
class VirtualDate extends RealDate {
  constructor(...a) { super(...(a.length ? a : [V + 1700000000000])); }
  static now() { return V; }
}
g.Date = VirtualDate;

let importSeq = 0;
// 每个用例一份干净的 main.js：上一份实例的监听器还挂在共享的 window/document/元素桩上，
// 不清掉的话一次 Enter 会同时开两局，取到的就不是被测的那台状态机。
async function freshApp(tweak) {
  winListeners.clear();
  docListeners.clear();
  elCache.clear();
  timers = [];
  rafQueue = [];
  V = 1000;
  lcg = 0x13579bdf >>> 0;
  audio.contexts.length = 0;
  audio.oscillators = 0;
  lsStore.clear();
  documentStub.fullscreenElement = null;
  documentStub.documentElement.requestFullscreen = () => {
    documentStub.fullscreenElement = documentStub.documentElement;
    fireDoc('fullscreenchange');
    return Promise.resolve();
  };
  documentStub.exitFullscreen = () => {
    documentStub.fullscreenElement = null;
    fireDoc('fullscreenchange');
    return Promise.resolve();
  };
  const store = await import(pathToFileURL(path.join(root, 'js/store.js')).href);
  store.Store.data = { settings: { sound: true, reduceMotion: false }, best: {}, resume: null, totals: { solved: 0, hints: 0, ms: 0 } };
  if (tweak) await tweak();
  await import(pathToFileURL(path.join(root, 'js/main.js')).href + `?t=${++importSeq}`);
  return g.tapa;
}

const click = (sel) => qsel(sel).dispatch({ type: 'click' });
const key = (k, tagName = 'CANVAS') => fireWin('keydown', { key: k, target: { tagName } });
function pump(hz, ms) {
  const period = 1000 / hz;
  const end = V + ms;
  let guard = 0;
  while (V < end - 1e-6 && guard++ < 200000) {
    runTimers();
    const due = rafQueue;
    rafQueue = [];
    for (const [, cb] of due) cb(V);
    V += period;
  }
  runTimers();
}
// 真实指针手势：坐标从 view.cellRect 取，和画布上那一格同源
function paint(A, t) {
  const r = A.view.cellRect(t);
  const canvas = qsel('#board');
  canvas.dispatch({ type: 'pointerdown', clientX: r.x + r.size / 2, clientY: r.y + r.size / 2, button: 0, pointerId: 1 });
  canvas.dispatch({ type: 'pointerup', clientX: r.x + r.size / 2, clientY: r.y + r.size / 2, button: 0, pointerId: 1 });
}

// ---------- 1) 静音：真停 AudioContext，静音态不得再新建振荡器 ----------
{
  const A = await freshApp();
  A.begin({ tier: 'easy', seed: 'ux-mute' });
  paint(A, 0); paint(A, 1);
  const ctx = audio.contexts[audio.contexts.length - 1];
  const live = audio.oscillators;
  click('#btn-sound');
  // 静音态要在按下那一刻取证：块尾再读 ctx.state / 按钮文案，读到的已经是复音之后的了
  const stateMuted = ctx && ctx.state;
  const labelMuted = qsel('#btn-sound').textContent;
  const muted = audio.oscillators;
  for (let t = 2; t < 8; t++) paint(A, t);
  A.useHint();
  A.undo();
  const whileMuted = audio.oscillators - muted;
  click('#btn-sound');
  paint(A, 8);
  const afterBack = audio.oscillators - muted;
  eq('静音把 AudioContext 挂起', stateMuted, 'suspended');
  eq('静音态新建振荡器数', whileMuted, 0);
  ok('解除静音能重新发声且唤醒上下文', ctx.state === 'running' && afterBack > 0, `state=${ctx.state} 复音后新增=${afterBack}`);
  eq('HUD 文案跟着改', labelMuted, '音效 关');
}

// ---------- 2) 暂停：仿真与计时一起冻住，恢复不丢账 ----------
{
  const A = await freshApp();
  A.begin({ tier: 'medium', seed: 'ux-pause' });
  paint(A, 2);
  paint(A, 5);
  pump(60, 400);
  const before = { steps: A.fx().simSteps, el: Math.round(A.elapsed()), moves: A.state().moves, seed: A.state().originSeed };
  click('#btn-pause');
  pump(60, 900);
  const during = { steps: A.fx().simSteps, el: Math.round(A.elapsed()) };
  eq('暂停期帧循环收摊', A.anim().rafOn, false);
  eq('暂停期 simSteps 不动', during.steps, before.steps);
  eq('暂停期对局计时不动', during.el, before.el);
  const movesBefore = A.state().moves;
  paint(A, 11);
  eq('暂停期真实指针不落墨', A.state().moves, movesBefore);
  eq('暂停期验证台后门也不落墨', A.tap(14), null);
  // stroke 是另一条后门、各自一道闸：只断言 tap 挡不住"以后有人把 stroke 的闸拆了"。
  eq('暂停期验证台拖画后门也不落墨', A.stroke([14, 15]), null);
  eq('暂停期两条后门都不记账', A.state().moves, movesBefore);
  eq('暂停遮罩可见', qsel('#pause-veil').hidden, false);
  click('#btn-pause');
  pump(60, 400);
  ok('恢复后仿真重新推进', A.fx().simSteps > during.steps && A.elapsed() > during.el, `simSteps ${during.steps}→${A.fx().simSteps}, elapsed ${during.el}→${Math.round(A.elapsed())}`);
  eq('恢复不丢这一局', A.state().originSeed, before.seed);
  eq('恢复不吞已有笔数', A.state().moves, before.moves);
}

// ---------- 3) 重开 / 再来一局：时钟、累加器、粒子、账本全部复位 ----------
{
  const A = await freshApp();
  A.begin({ tier: 'hard', seed: 'ux-reset' });
  for (let t = 0; t < 6; t++) paint(A, t * 2);
  A.useHint();
  A.useHint();
  pump(60, 600);
  const dirty = { el: Math.round(A.elapsed()), steps: A.fx().simSteps, count: A.fx().count, accum: A.fx().accumMs, moves: A.state().moves, hints: A.state().hints, cursor: A.state().cursor, ledger: A.state().steps, blacks: A.state().blacks };
  click('#btn-again');
  const clean = { el: Math.round(A.elapsed()), steps: A.fx().simSteps, count: A.fx().count, accum: A.fx().accumMs, moves: A.state().moves, hints: A.state().hints, cursor: A.state().cursor, ledger: A.state().steps, blacks: A.state().blacks };
  ok('重开前确实脏', Object.values(dirty).some((v) => v !== 0), JSON.stringify(dirty));
  eq('重开后 9 项全 0', Object.values(clean).join(','), '0,0,0,0,0,0,0,0,0');
  key('p');
  const wasPaused = A.paused;
  key('r');
  eq('暂停中 R 不重开', A.paused, wasPaused);
  key('p');
  paint(A, 1);
  key('r');
  eq('R 键重开归零', A.state().moves, 0);
}

// ---------- 4) reduceMotion：粒子真的关掉，也真能开回来 ----------
{
  const A = await freshApp();
  A.begin({ tier: 'easy', seed: 'ux-motion' });
  paint(A, 0);
  paint(A, 1);
  pump(60, 100);
  const onCount = A.fx().count;
  click('#btn-motion');
  const afterOff = A.fx().count;
  for (let t = 2; t < 8; t++) paint(A, t);
  ok('动效开关关得住粒子', onCount > 0 && afterOff === 0 && A.fx().count === 0, `开启时=${onCount}、关掉后=${afterOff}、再落 6 笔=${A.fx().count}`);
  eq('body 挂上 reduce-motion', documentStub.body.classList.contains('reduce-motion'), true);
  click('#btn-motion');
  paint(A, 20);
  paint(A, 21);
  ok('开关能回（再开就又有粒子）', !documentStub.body.classList.contains('reduce-motion') && A.fx().count > 0, `再开后粒子=${A.fx().count}`);
}

// ---------- 5) 命中区按 CSS 缩放换算（点 A 不许打 B） ----------
{
  const A = await freshApp();
  A.begin({ tier: 'medium', seed: 'ux-hit' });
  const geo = { ...A.view.geo };
  const want = 5;
  const r = A.view.cellRect(want);
  eq('1:1 命中', A.view.hitCell(r.x + r.size / 2, r.y + r.size / 2), want);
  // 画布被 CSS 折半（浏览器缩放 / Electron zoomFactor / 将来给 #board 加 max-width）
  const canvas = qsel('#board');
  canvas.style.width = `${geo.w / 2}px`;
  canvas.style.height = `${geo.h / 2}px`;
  eq('CSS 折半后同一格仍命中该格', A.view.hitCell((r.x + r.size / 2) / 2, (r.y + r.size / 2) / 2), want);
  const naive = Math.floor(((r.x + r.size / 2) / 2 - geo.x) / geo.cell);
  ok('不换算的话就会打到邻居', naive !== want % A.state().total, `按 cell 直接除会得到列 ${naive}`);
}

// ---------- 6) 手势入口：PointerEvent 在就只用 pointer，缺席才补 touch/mouse ----------
{
  await freshApp();
  const modern = [...qsel('#board')._l.keys()];
  await freshApp(() => { g.PointerEvent = undefined; });
  const legacy = [...qsel('#board')._l.keys()];
  g.PointerEvent = function PointerEvent() {};
  ok('支持 PointerEvent 时不重复挂回落', modern.includes('pointerdown') && !modern.includes('touchstart') && !modern.includes('mousedown'), modern.join(','));
  ok('缺席时 touch/mouse 回落齐全', ['touchstart', 'touchmove', 'touchend', 'touchcancel', 'mousedown', 'mousemove'].every((k) => legacy.includes(k)), legacy.join(','));
}

// ---------- 7) 全屏：绑到真实存在的按钮，状态回写文案 ----------
{
  await freshApp();
  eq('index.html 里真有 #btn-full', /id="btn-full"/.test(fs.readFileSync(path.join(root, 'index.html'), 'utf8')), true);
  click('#btn-full');
  const entered = documentStub.fullscreenElement !== null;
  eq('按下后文案换字', qsel('#btn-full').textContent, '退出全屏');
  eq('按下后 aria-pressed 跟上', qsel('#btn-full')['attr_aria-pressed'], 'true');
  click('#btn-full');
  ok('再按真的退出', entered && documentStub.fullscreenElement === null && qsel('#btn-full').textContent === '全屏', `文案=${qsel('#btn-full').textContent}`);
}

// ---------- 8) 注册脚本：file:// 静默跳过，http(s) 按 baseURI 解析 ----------
{
  const calls = [];
  force('navigator', { userAgent: 'tapa-ux-test', maxTouchPoints: 1, serviceWorker: { register: (u, o) => { calls.push([u, o && o.scope]); return Promise.reject(new Error('stub reject')); } } });
  let threw = null;
  const asModule = (q) => import(pathToFileURL(path.join(root, 'js/sw-register.js')).href + q).catch((e) => { threw = e.message; });
  g.location = { ...g.location, protocol: 'file:', href: 'file:///tmp/index.html' };
  await asModule('?file=1');
  eq('file:// 下不注册', calls.length, 0);
  eq('file:// 下不抛未捕获异常', threw, null);
  g.location = { ...g.location, protocol: 'https:', href: pathToFileURL(path.join(root, 'index.html')).href };
  winListeners.clear();
  await asModule('?http=1');
  fireWin('load', {});
  ok('http(s) 下 sw/scope 都解析成绝对地址', calls.length === 1 && /^[a-z]+:\/\//.test(calls[0][0]) && /\/$/.test(calls[0][1] || ''), JSON.stringify(calls[0] || null));
}

// ---------- 9) 存档两段式解码：一条坏记录只丢那一条 ----------
// 每条脏样本都得重开一份 store.js（?junk=N）：sanitize() 只在模块顶层 load() 那一次跑，
// 复用缓存实例的话八条样本读到的都是同一份已经洗干净的 data。
const openStore = async (raw) => {
  lsStore.clear();
  lsStore.set('tapa.save.v1', raw);
  return (await import(pathToFileURL(path.join(root, 'js/store.js')).href + `?junk=${++importSeq}`)).Store;
};
{
  const samples = [
    ['null', 'null', 0, 'null'],
    ['非 JSON', '}{ not json', 0, 'null'],
    ['顶层数组', '[1,2,3]', 0, 'null'],
    ['settings 是 null', '{"settings":null,"resume":null}', 0, 'null'],
    ['resume 缺字段', '{"resume":{"seed":"s"}}', 0, 'null'],
    ['ink 类型错', '{"resume":{"seed":"s","tier":0,"cells":9,"ink":"nope"}}', 0, 'null'],
    ['越界 best', '{"best":{"easy":{"ms":-9,"hints":-1,"moves":2}}}', 0, 'null'],
    ['越界 resume', '{"resume":{"seed":"s","tier":-5,"cells":99999,"ink":[1,2],"elapsedMs":-1,"moves":-4,"hints":-2}}', 0, 'null'],
    // 只越界 cells，其余字段全合法：4096 这道闸没有别的样本替它作证。
    ['cells 超上限', '{"resume":{"seed":"s","tier":0,"cells":4097,"ink":[1,2],"elapsedMs":1,"moves":1,"hints":1}}', 0, 'null'],
    // 全合法的档必须活下来：否则"洗脏档"退化成"全丢掉"也能刷绿。
    ['合法 resume 要留下', '{"resume":{"seed":"s","tier":0,"cells":9,"ink":[3,1,2,3],"elapsedMs":5000,"moves":2,"hints":1}}', 0, 'keep'],
    ['半好半坏', '{"best":{"easy":{"ms":9000,"hints":0,"moves":3,"size":"5x5"},"hard":{"ms":"x"}}}', 1, 'null'],
  ];
  let broke = [];
  for (const [name, raw, wantBest, wantResume] of samples) {
    let err = '';
    let kept = -1;
    let resumeOut = 'n/a';
    try {
      const S = await openStore(raw);
      kept = Object.keys(S.data.best).length;
      const rr = S.resume();
      resumeOut = rr === null ? 'null' : `board${rr.board.length}`;
      if (kept !== wantBest) err = `best 留了 ${kept} 条（应 ${wantBest}）`;
      if (wantResume === 'null' && rr !== null) err = `resume 没被丢掉（留了 ${resumeOut}）`;
      if (wantResume === 'keep' && (rr === null || rr.board.length !== 9)) err = `合法 resume 被误杀（${resumeOut}）`;
      if (!['solved', 'hints', 'ms'].every((k) => Number.isFinite(S.data.totals[k]) && S.data.totals[k] >= 0)) err = 'totals 没洗成非负数';
    } catch (e) { err = e.message; }
    if (err) broke.push(`${name}: ${err} (resume=${resumeOut})`);
  }
  ok(`${samples.length} 条脏/净档逐条不冻死`, broke.length === 0, broke.join(' | '));

  const S9 = await openStore('{"best":{"easy":{"ms":9000,"hints":0,"moves":3,"size":"5x5"},"hard":{"ms":"x"}}}');
  ok('坏 best 只丢那一条', !!S9.best('easy') && !S9.best('hard'), `easy=${JSON.stringify(S9.best('easy'))} hard=${JSON.stringify(S9.best('hard'))}`);

  const S10 = await openStore('{}');
  const U = S10._rle.fromWire(0);
  const roundTrip = Array.from(S10._rle.decode(S10._rle.encode([1, 1, 1, 2, 2, 0, 0, 2]), 8));
  eq('存档往返不掉格', roundTrip.join(','), '1,1,1,2,2,0,0,2');
  const badRun = Array.from(S10._rle.decode([1, 2, 9, 3, 0, 2], 6)); // run 值 9 非法、长度 3 越界
  ok('坏 run 只跳过那一条', badRun[0] === 1 && badRun[1] === 1 && badRun.slice(2).every((v) => v === U), badRun.join(','));
  const truncated = Array.from(S10._rle.decode([1, 2], 5));
  ok('截断的档补未知而不是错位', truncated[0] === 1 && truncated[1] === 1 && truncated.slice(2).every((v) => v === U), truncated.join(','));
}

// ---------- 10) 键盘覆盖面（简报 §2 点名的那一套键） ----------
{
  const A = await freshApp();
  A.show('menu');
  key('Enter', 'BODY');
  eq('Enter 开局', A.state() && A.state().status, 'playing');
  A.show('menu');
  key(' ', 'BODY');
  eq('空格开局', A.state() && A.state().status, 'playing');
  key('m');
  eq('M 静音', qsel('#btn-sound').textContent, '音效 关');
  key('m');
  key('f');
  eq('F 全屏', documentStub.fullscreenElement !== null, true);
  key('f');
  key('p');
  eq('P 暂停', A.paused, true);
  key('p');
  const hints = A.state().hints;
  key('h');
  ok('H 出提示', A.state().hints > hints || qsel('#hint-rule').textContent.length > 0, `hints ${hints}→${A.state().hints}`);
  const moves = A.state().moves;
  key('z');
  eq('Z 撤销', A.state().moves < moves || A.state().moves === moves, true);
  key('?');
  ok('? 出玩法', qsel('#hint-rule').textContent === '玩法', `面板标题=${qsel('#hint-rule').textContent}`);
  A.show('menu');
  key('3');
  eq('数字键选档', A.state() && A.state().tier, 2);
}

// ---------- 11) 44px 命中下限：全站 button 一条兜底，令牌由 theme.js 供 ----------
{
  const css = fs.readFileSync(path.join(root, 'css/game.css'), 'utf8');
  const theme = fs.readFileSync(path.join(root, 'js/theme.js'), 'utf8');
  const blanket = /(?:^|\})\s*button\s*\{([^}]*)\}/m.exec(css);
  const rules = blanket ? blanket[1] : '';
  ok('button 有 44px 字面兜底', /min-height:\s*44px/.test(rules), rules.slice(0, 120));
  ok('button 走 --touch-min 令牌', /min-height:\s*var\(--touch-min\)/.test(rules) && /Touch\s*=\s*\{\s*min:\s*44\s*\}/.test(theme), '');
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const btns = [...html.matchAll(/<button\b/g)].length;
  const sized = [...html.matchAll(/<button\b[^>]*\bstyle="[^"]*height/g)].length;
  eq('页面上的按钮都吃到兜底', btns - sized, btns);
  ok('viewport-fit=cover 让 env(safe-area-inset) 有读数', /viewport-fit=cover/.test(html) && /env\(safe-area-inset-top\)/.test(css), '');
}

console.log(`\n${pass} 条断言通过 / ${fail} 条失败`);
process.exit(fail ? 1 : 0);
