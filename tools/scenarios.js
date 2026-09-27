// Browser-side scenario suite, injected by tools/playtest.cjs and run against the real page.
//
// The rule for anything asserted here: read the DOM, the geometry and the canvas pixels, not an
// internal flag. `game.stuck === true` says what the code intended; `#state-line`'s text, a client
// rect and a pixel say what the player got. The interesting failures in this game are exactly the
// ones where the state is right and the picture or the click is wrong — a clue whose `0 0 0` paints
// like "no clue here", a board that fits the model but not the viewport, a hint that rings a
// different cell from the one it names, a save that replays 25 cells onto a 49-cell board.
//
// window.tapa.engine is the shipped module graph, so a scenario that passes here has passed on the
// same solver the player's hints come from — not a second copy kept for testing.
//
// ck(name, condition, detail) is truthiness; eq(name, got, want) is equality. Every "must equal"
// below therefore goes through eq, because `ck('count', 0)` reads as a failure to a human and a pass
// to a boolean. A scenario whose every assertion would pass whatever the page did is worse than no
// scenario, so each one carries at least one control sample (a cell that must *not* show the thing
// the tested cell shows).

((w) => {
  const rows = [];
  const ck = (test, cond, detail) => {
    rows.push({ test, pass: !!cond, detail: cond ? '' : String(detail === undefined ? '' : detail) });
  };
  const eq = (test, got, want) => ck(test, String(got) === String(want), `got ${got} / want ${want}`);
  const report = (extra) => {
    // rows is copied, not aliased: the array is cleared below, and a live reference would hand back
    // an empty report that still reads as "0 failed".
    const out = { rows: rows.slice(), fail: rows.filter((r) => !r.pass).length, ...extra };
    rows.length = 0;
    return out;
  };
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  const A = () => w.tapa;
  const E = () => w.tapa.engine;
  const TH = () => E().theme;
  const $ = (sel) => document.querySelector(sel);
  const text = (sel) => (($.call(document, sel) || {}).textContent || '').trim();
  const shown = (sel) => {
    const e = $(sel);
    if (!e) return false;
    return getComputedStyle(e).display !== 'none' && e.getClientRects().length > 0;
  };
  const cssVar = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

  // Every scenario starts from an empty save: the resume card, the record list and the totals all
  // come out of localStorage, and a scenario must not go green because the one before it left a
  // board half-painted.
  const wipe = async () => {
    E().Store.reset();
    A().show('menu');
    await wait(20);
  };
  const open = async (tier, seed) => {
    const g = A().begin({ tier, seed });
    await wait(50);
    return g;
  };
  const inkCount = () => Number(text('#stat-blacks')) + Number(text('#stat-whites'));

  // ---- gestures through the real pointer path --------------------------------
  // These drive the page's own pointerdown/move/up listeners, so a scenario that paints by
  // dispatching events has exercised hitCell, the preview and the commit — not a re-implementation.
  function pointer(type, x, y, button) {
    const ev = new PointerEvent(type, {
      bubbles: true,
      cancelable: true,
      pointerId: 1,
      isPrimary: true,
      clientX: x,
      clientY: y,
      button: button || 0,
      buttons: type === 'pointerup' ? 0 : 1,
    });
    A().view.canvas.dispatchEvent(ev);
    return ev;
  }
  const at = (t) => {
    const r = A().view.cellRect(t);
    const box = A().view.canvas.getBoundingClientRect();
    return { x: box.left + r.x + r.size / 2, y: box.top + r.y + r.size / 2, size: r.size };
  };
  async function tap(t, button) {
    const p = at(t);
    pointer('pointerdown', p.x, p.y, button);
    pointer('pointerup', p.x, p.y, button);
    return wait(24);
  }
  async function drag(from, to, button) {
    const a = at(from);
    const b = at(to);
    const steps = Math.max(2, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / (a.size / 3)));
    pointer('pointerdown', a.x, a.y, button);
    for (let i = 1; i <= steps; i++) {
      pointer('pointermove', a.x + ((b.x - a.x) * i) / steps, a.y + ((b.y - a.y) * i) / steps, button);
    }
    pointer('pointerup', b.x, b.y, button);
    return wait(24);
  }

  // ---- pixels ----------------------------------------------------------------
  const hex = (h) => {
    const m = String(h).replace('#', '');
    return m.length < 6 ? [-1, -1, -1] : [parseInt(m.slice(0, 2), 16), parseInt(m.slice(2, 4), 16), parseInt(m.slice(4, 6), 16)];
  };
  const rgb = (s) => {
    const m = String(s).match(/(\d+)[,\s]+(\d+)[,\s]+(\d+)/);
    return m ? [+m[1], +m[2], +m[3]] : [-1, -1, -1];
  };
  const near = (p, c, tol = 10) => p.length === 3 && p.every((v, i) => Math.abs(v - c[i]) <= tol);
  function pixel(x, y) {
    const v = A().view;
    const d = v.geo.dpr;
    const p = v.ctx.getImageData(Math.round(x * d), Math.round(y * d), 1, 1).data;
    return [p[0], p[1], p[2]];
  }
  // The middle of a cell: no grid line (those sit on the boundaries) and no clue plate (those sit at
  // the renderer's SLOT_ANCHOR fractions, never at 0.5/0.5) — so this pixel reads the cell's own
  // colour, which is the one thing the three states 黑 / 白 / 未定 have to differ in.
  const centrePixel = (t) => {
    const r = A().view.cellRect(t);
    return pixel(r.x + r.size / 2, r.y + r.size / 2);
  };
  // How many points on a circle *inside* one cell's square carry this colour. Used for the dashed
  // `0 0 0` hoop (0.30 cell) and the satisfied-clue ring (0.44 cell): the two radii never coincide,
  // so a control cell gives a real zero rather than a leak from the tested one.
  function onCircle(t, frac, color, tol, n) {
    const v = A().view;
    const r = v.cellRect(t);
    const cx = r.x + r.size / 2;
    const cy = r.y + r.size / 2;
    const rad = r.size * frac;
    const want = hex(color);
    let hit = 0;
    for (let k = 0; k < n; k++) {
      const ang = (k / n) * Math.PI * 2;
      if (near(pixel(cx + Math.cos(ang) * rad, cy + Math.sin(ang) * rad), want, tol)) hit++;
    }
    return hit;
  }
  // The ring a hint (or a contradiction) leaves around the cell it just named: a rounded rect inset
  // 2px from the cell square. Only the straight middle of each side is sampled, so the corner radius
  // cannot hide the stroke and a neighbour's digit plate cannot fake it.
  function onPulseRect(t, color, tol) {
    const v = A().view;
    const r = v.cellRect(t);
    const cell = r.size;
    const inset = 2;
    const lw = Math.max(2.5, cell * 0.09);
    const want = hex(color);
    const lo = inset + lw;
    const hi = cell - inset - lw;
    let hit = 0;
    const n = 8;
    for (let k = 0; k < n; k++) {
      const f = lo + ((hi - lo) * k) / (n - 1);
      for (const xy of [[r.x + f, r.y + inset], [r.x + f, r.y + cell - inset], [r.x + inset, r.y + f], [r.x + cell - inset, r.y + f]]) {
        if (near(pixel(xy[0], xy[1]), want, tol)) hit++;
      }
    }
    return hit;
  }
  // Bright ink of one colour inside the little plate a digit is drawn on.
  function glyphInk(clueCell, slot, color, tol) {
    const v = A().view;
    const p = v.slotPoint(clueCell, slot);
    const half = Math.max(5, v.geo.cell * 0.17);
    const d = v.geo.dpr;
    const box = v.ctx.getImageData(Math.round((p.x - half) * d), Math.round((p.y - half) * d), Math.round(2 * half * d), Math.round(2 * half * d)).data;
    const want = hex(color);
    let hit = 0;
    for (let k = 0; k < box.length; k += 4) {
      if (box[k + 3] > 200 && near([box[k], box[k + 1], box[k + 2]], want, tol)) hit++;
    }
    return hit;
  }

  // ---------- engine ----------
  // Hand-checkable anchors only: ring geometry read off a 3×3 on paper, the clue triple's encoding,
  // and small boards whose whole answer set can be written out by hand.
  const engine = async () => {
    const en = E();
    ck('页面挂出了可测的引擎', !!(en && en.createBoard && en.solve && en.analyze && en.verify));
    eq('白 0 · 黑 1', `${en.WHITE},${en.BLACK}`, '0,1');
    eq('未知不占用 0（0 0 0 是合法线索值）', en.UNKNOWN, 2);
    eq('「这里没数字」的哨兵是 -1', en.NO_CLUE, -1);
    eq('0 0 0 不是哨兵', `${en.isZeroClue(0)},${en.isZeroClue(en.NO_CLUE)}`, 'true,false');
    eq('五条规则', Object.keys(en.Rules).length, 5);
    eq('首页写的五条规则名与引擎一致', [...document.querySelectorAll('.rules li b')].map((b) => b.textContent).join(','), Object.values(en.Rules).map((r) => r.name).join(','));
    eq('点击轮转是 未知→黑→白→未知', [en.nextValue(en.UNKNOWN), en.nextValue(en.BLACK), en.nextValue(en.WHITE)].join(','), '1,0,2');
    eq('档位有五级', en.TIERS.length, 5);
    // The five bands are measured, and two neighbours are allowed to *touch* (newbie tops out at 48,
    // easy starts at 48) — what is not allowed is an inversion, a tier whose whole window sits below
    // the one before it. Read the ladder as: low strictly rising, high strictly rising, never crossing.
    let ordered = true;
    const crossed = [];
    for (let i = 1; i < en.TIERS.length; i++) {
      const a = en.TIERS[i - 1], b = en.TIERS[i];
      if (!(b.band[0] >= a.band[1])) crossed.push(`${a.key}→${b.key} low ${b.band[0]} < ${a.key} high ${a.band[1]}`);
      if (!(b.band[0] > a.band[0] && b.band[1] > a.band[1])) crossed.push(`${a.key}→${b.key} 区间端点没有同时上移`);
      if (!(b.size[0] > a.size[0] && b.size[1] > a.size[1])) crossed.push(`${a.key}→${b.key} 盘面没有变大`);
    }
    eq('档位阶梯：区间端点递增、首尾不交叉、盘面逐级变大', crossed.join(' | '), '');
    const tsum = en.TIERS.reduce((x, t) => x + t.band[0] + t.band[1], 0);
    eq('不认识的档位退回入门', en.tierFor('nope').key, 'newbie');

    // ring geometry, read off a 3×3 on paper (index = row*3 + col)
    eq('左上角的环只有三格', Array.from(en.ringCells(3, 3, 0)).join(','), '1,4,3');
    eq('上边中点的环五格', Array.from(en.ringCells(3, 3, 1)).join(','), '2,5,4,3,0');
    eq('右上角的环三格', Array.from(en.ringCells(3, 3, 2)).join(','), '5,4,1');
    eq('盘心的环整八格：从北开始顺时针', Array.from(en.ringCells(3, 3, 4)).join(','), '1,2,5,8,7,6,3,0');
    eq('盘心第一格是北', en.ringLabel(3, 3, 4, 0), '北');
    eq('左上角第一格是东', en.ringLabel(3, 3, 0, 0), '东');
    eq('右上角最后一格是西', en.ringLabel(3, 3, 2, 2), '西');

    // cycle vs path: getting this wrong is quiet and fatal
    eq('盘心环：北与西北相接，是一段两格', en.ringRuns(129, 8).join(','), '2');
    eq('七格环（少一个方向）：两端不接头', en.ringRuns(65, 7).join(','), '1,1');
    eq('整圈全黑是一段八格，不会自加', en.ringRuns(255, 8).join(','), '8');
    eq('顺序是线索的一部分：2 1', en.ringRuns(19, 8).join(','), '2,1');
    eq('顺序是线索的一部分：1 2', en.ringRuns(13, 8).join(','), '1,2');
    eq('2 1 与 1 2 不相等', en.sameRuns([2, 1], [1, 2]), false);
    // double entry: read the ring again, written fresh in this file, and compare mask by mask
    const ownRuns = (mask) => {
      const out = [];
      let run = 0;
      for (let s = 0; s < 8; s++) {
        if (mask & (1 << s)) run++;
        else if (run) { out.push(run); run = 0; }
      }
      if (run) out.push(run);
      if (out.length > 1 && (mask & 1) && (mask & 128)) out[0] += out.pop();
      return out;
    };
    const p21 = en.ringPatterns(en.encodeClue(2, 1), 8);
    const p12 = en.ringPatterns(en.encodeClue(1, 2), 8);
    let disagree = 0;
    for (let m = 0; m < 256; m++) {
      if ((ownRuns(m).join(',') === '2,1') !== p21.includes(m)) disagree++;
    }
    eq('环上相容的排法集与现场重写的读法逐 mask 相同', disagree, 0);
    ck('2 1 的排法集不是空的', p21.length > 0 && p21.length < 256, String(p21.length));
    eq('2 1 与 1 2 的排法互不相交', p21.filter((m) => p12.includes(m)).length, 0);
    eq('2 1 收下「北东北 + 南」这一排法', p21.includes(19), true);
    eq('2 1 不收「北 + 东东南」（那是 1 2）', p21.includes(13), false);

    // the clue triple
    eq('尾零不写：3 就是 3 0 0', en.clueDigits(en.encodeClue(3)).join(','), '3');
    eq('两个数就是两个数', en.clueDigits(en.encodeClue(3, 1)).join(','), '3,1');
    eq('0 0 0 读出三个零', en.clueDigits(0).join(','), '0,0,0');
    eq('无线索什么也不读', en.clueDigits(en.NO_CLUE).length, 0);
    eq('段数之和', en.clueSum(en.encodeClue(3, 1)), 4);
    eq('非零段', en.clueRuns(en.encodeClue(3, 0, 1)).join(','), '3,1');
    eq('无线索的读法不是空字符串', en.describeClue(en.NO_CLUE), '（无线索）');

    // board construction refuses nonsense
    const refuses = (fn, re) => {
      try {
        fn();
        return '';
      } catch (e) {
        return re.test(e.message);
      }
    };
    const only = (n, i, v) => {
      const a = new Int16Array(n).fill(en.NO_CLUE);
      a[i] = v;
      return a;
    };
    eq('线索超过环长：拒绝开局', refuses(() => en.createBoard(3, 3, only(9, 0, en.encodeClue(4))), /环上只有 3 格/), true);
    eq('clue 长度不符：拒绝开局', refuses(() => en.createBoard(3, 3, [0]), /clue length mismatch/), true);
    eq('满盘无线索：拒绝开局', refuses(() => en.createBoard(3, 3, new Int16Array(9).fill(en.NO_CLUE)), /盘上没有线索/), true);
    eq('小于 3×3：拒绝开局', refuses(() => en.createBoard(2, 2, new Int16Array(4).fill(0)), /盘至少 3×3/), true);

    // `0 0 0` alone is strong enough to finish a 3×3: its cell and all eight neighbours are white
    const zb = en.createBoard(3, 3, only(9, 4, 0));
    const zs = en.solve(zb);
    ck('只有一个 0 0 0 也推得完全盘', zs.ok === true, JSON.stringify({ ok: zs.ok, undetermined: zs.undetermined }));
    eq('0 0 0 的九格全白', Array.from(zs.derived).join(''), '000000000');
    const za = en.analyze({ w: 3, h: 3, clue: zb.clue }, { limit: 2, maxNodes: 500000 });
    eq('穷举计数器也说这盘唯一', za.code, 'unique');
    eq('两套互不信任的代码逐格同解', Array.from(za.forced).join(','), Array.from(zs.derived).join(','));
    eq('穷举走完了（不是被预算截断的）', za.exhaustive, true);

    // a single `1` in the middle forces exactly one cell and nothing else
    const s1 = en.createBoard(3, 3, only(9, 4, en.encodeClue(1)));
    const r1 = en.solve(s1, { useNishio: false });
    eq('线索自黑写了盘心那一格', r1.derived[4], en.BLACK);
    eq('其余八格仍是未知（规则不越权）', Array.from(r1.derived).filter((v, i) => i !== 4 && v !== en.UNKNOWN).length, 0);
    eq('一条线索推不完 3×3', r1.undetermined, 8);
    eq('推不完就是不出货', r1.ok, false);

    // rule 2 from the other side, and the independent verifier against a whole board
    const p = en.generate('scen|engine', 0);
    ck('出一局（引擎场景用）', !!p);
    const full = en.createBoard(5, 5, en.cluesFrom(5, 5, p.solution));
    eq('答案自己通过独立验收', en.verify(full, Int8Array.from(p.solution)).length, 0);
    eq('满数字盘也推得完', en.verify(full, en.solve(full).derived).length, 0);
    const allWhite = new Int8Array(25).fill(en.WHITE);
    const allBlack = new Int8Array(25).fill(en.BLACK);
    eq('满盘皆黑时没有一条数字算对上', en.diagnose(full, allBlack).satisfied.size, 0);
    eq('满盘皆黑时每格都在某个二乘二里', en.diagnose(full, allBlack).blocks.size, 25);
    eq('满盘皆白时被点名的是每条非零线索',
      new Set(en.verify(full, allWhite).filter((x) => x.kind === 'clue').map((x) => x.clue)).size,
      full.clues - full.zeroClues);
    const flipped = Int8Array.from(p.solution);
    flipped[7] = flipped[7] === en.BLACK ? en.WHITE : en.BLACK;
    ck('翻一格必有数字对不上', en.verify(full, flipped).length >= 1, JSON.stringify(en.verify(full, flipped).map((x) => x.kind)));
    // a 2×2 in an otherwise white board: that block is the only thing wrong with it
    const blk = new Int8Array(25).fill(en.WHITE);
    for (const t of [6, 7, 11, 12]) blk[t] = en.BLACK;
    const blkBoard = en.createBoard(5, 5, en.cluesFrom(5, 5, blk));
    const bpro = en.verify(blkBoard, blk);
    eq('白海里一个二乘二：只点名一处', bpro.length, 1);
    eq('点名的是二乘二', bpro[0].kind, 'block');
    blk[12] = en.WHITE;
    // The picture changed but the clues were still read off the old one, so they now complain about
    // that corner's neighbours — and about the cell that used to be black. Both facts are worth nailing:
    // a clue is a ring, and a clue cell is a black cell.
    const torn = en.verify(blkBoard, blk);
    ck('改图不改线索：对不上的全是数字', torn.length > 0 && torn.every((x) => x.kind === 'clue'), JSON.stringify(torn.map((x) => x.kind)));
    eq('改图不改线索：被点名的正是那一角和它的邻居', torn.map((x) => x.cell).sort((a, b) => a - b).join(','), '6,7,11,12');
    eq('同一张新图重新出题就合法了', en.verify(en.createBoard(5, 5, en.cluesFrom(5, 5, blk)), blk).length, 0);
    // two decided whites that can never meet again
    const two = new Int8Array(25).fill(en.BLACK);
    two[0] = en.WHITE;
    two[24] = en.WHITE;
    const twoBoard = en.createBoard(5, 5, only(25, 12, 0));
    const tpro = en.verify(twoBoard, two);
    ck('两块分开的白格被点名', tpro.filter((x) => x.kind === 'link').length >= 1, JSON.stringify(tpro.map((x) => x.kind)));
    eq('被点名的白格进入 linkCells', en.diagnose(twoBoard, two).linkCells.size, 1);
    eq('空盘不判胜', en.complete(twoBoard, new Int8Array(25).fill(en.UNKNOWN)), false);
    eq('空盘没有冲突', en.diagnose(twoBoard, new Int8Array(25).fill(en.UNKNOWN)).problems.length, 0);
    eq('满白盘的 3×3 每格都能写 0 0 0', en.cluesFrom(3, 3, new Int8Array(9).fill(en.WHITE)).includes(en.NO_CLUE), false);
    eq('白格被黑格封死时 reachable 说没有出路', en.reachable(twoBoard, two), false);
    return report({ fullClues: full.clues, fullZero: full.zeroClues, zaNodes: za.nodes, p21: p21.length });
  };

  // ---------- gen ----------
  const gen = async () => {
    const en = E();
    const medians = [];
    const timing = {};
    for (const tier of en.TIERS) {
      const idx = en.tierIndexFor(tier.key);
      const scores = [];
      const clueCount = [];
      let inBand = 0;
      let unique = 0;
      let finishable = 0;
      let ms = 0;
      let ams = 0;
      let deep = 0;
      for (let s = 0; s < 4; s++) {
        const t0 = performance.now();
        const p = en.generate(`gen|${tier.key}|${s}`, idx);
        ms += performance.now() - t0;
        if (!p) continue;
        scores.push(p.score);
        clueCount.push(p.clues);
        if (p.score >= tier.band[0] && p.score <= tier.band[1]) inBand++;
        if (en.solve(p.board).ok) finishable++;
        const a0 = performance.now();
        const a = en.analyze({ w: p.w, h: p.h, clue: p.board.clue }, { limit: 2, maxNodes: 500000 });
        ams += performance.now() - a0;
        deep = Math.max(deep, a.nodes);
        if (a.code === 'unique' && a.exhaustive) unique++;
      }
      eq(`${tier.key} 出货 4/4`, scores.length, 4);
      ck(`${tier.key} 命中实测区间`, inBand >= 3, `${inBand}/4 在 ${tier.band}`);
      eq(`${tier.key} 每局都被穷举证到唯一解`, unique, scores.length);
      eq(`${tier.key} 每局推得完`, finishable, scores.length);
      ck(`${tier.key} 数字确实被删过`, Math.max(...clueCount) < tier.size[0] * tier.size[1], `${clueCount.join('/')} vs ${tier.size[0] * tier.size[1]} 格`);
      ck(`${tier.key} 出题够快`, ms / 4 < 400, `${(ms / 4).toFixed(0)} ms/局`);
      ck(`${tier.key} 穷举复核够快`, ams / 4 < 400, `${(ams / 4).toFixed(0)} ms/局 · 最深 ${deep} 节点`);
      timing[tier.key] = { gen: +(ms / 4).toFixed(1), prove: +(ams / 4).toFixed(1), nodes: deep };
      medians.push({ key: tier.key, m: scores.slice().sort((x, y) => x - y)[1], size: tier.size.join('×') });
    }
    let mono = true;
    for (let i = 1; i < medians.length; i++) if (!(medians[i].m > medians[i - 1].m)) mono = false;
    ck('档位中位分数单调递增', mono, medians.map((o) => `${o.key}:${o.m}`).join(' '));
    eq('每档盘面都不一样大', new Set(medians.map((o) => o.size)).size, 5);

    // the generator is deterministic in its seed, because the save file stores only the seed
    const a = en.generate('gen|same', 3);
    const again = en.generate('gen|same', 3);
    eq('同种子同盘', Array.from(again.board.clue).join(','), Array.from(a.board.clue).join(','));
    ck('不同种子不同盘', Array.from(en.generate('gen|other', 3).board.clue).join(',') !== Array.from(a.board.clue).join(','));
    eq('出货记下的是原始种子', a.seed, 'gen|same');

    // The pencil path finishing a board *is* the uniqueness proof: every write it makes holds in
    // every solution, so once all n cells are written there is nothing left to vary. The runtime
    // "当日种子" boards ship without a bake row, so that implication is checked here with the second
    // implementation rather than asserted in prose.
    const d = new Date();
    const dayKey = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const day = en.generate(`day|${dayKey}|master|0`, 4);
    ck('当日种子的 11×11 出得来', !!day, JSON.stringify(day && { attempts: day.attempts }));
    eq('当日种子推得完', en.solve(day.board).ok, true);
    eq('当日种子推满了盘', en.solve(day.board).undetermined, 0);
    const da = en.analyze({ w: day.w, h: day.h, clue: day.board.clue }, { limit: 2, maxNodes: 500000 });
    eq('当日种子的唯一解由穷举复核', da.code, 'unique');
    eq('穷举认下这一盘的全部格子', da.forced.filter((v) => v !== en.UNKNOWN).length, day.board.n);

    // Control group: random deletion from a full clue board. The counter, not the generator, decides
    // — and wherever it says "more than one", the rules must refuse to finish.
    let many = 0;
    let fooled = 0;
    let walked = 0;
    for (let s = 0; s < 12; s++) {
      let x = 31 + s * 977;
      const rand = () => {
        x ^= x << 13; x >>>= 0; x ^= x >> 17; x ^= x << 5; x >>>= 0; return x / 4294967296;
      };
      const ink = en.randomInk(5, 5, rand, 0.42);
      const full5 = en.createBoard(5, 5, en.cluesFrom(5, 5, ink.cells));
      const clue = Int16Array.from(full5.clue);
      for (let i = 0; i < 14; i++) clue[(i * 7 + s * 3) % clue.length] = en.NO_CLUE;
      const bd = en.createBoard(5, 5, clue);
      const c = en.analyze({ w: 5, h: 5, clue }, { limit: 2, maxNodes: 200000 });
      if (!c.exhaustive) continue;
      walked++;
      if (c.code !== 'unique') {
        many++;
        if (en.solve(bd, { useNishio: false }).ok) fooled++;
      }
    }
    ck('对照组都走得了穷举', walked >= 10, `${walked}/12`);
    ck('随机乱删会造出非唯一盘（对照组不是空的）', many >= 5, String(many));
    eq('非唯一盘不会被规则误判推完', fooled, 0);
    return report({ medians: medians.map((o) => o.m), timing });
  };

  // ---------- library (the baked campaign, re-derived in the browser) ----------
  const library = async () => {
    const en = E();
    eq('烘焙题单三十局', en.LIBRARY.length, 30);
    eq('题单种子互不重复', new Set(en.LIBRARY.map((r) => r.seed)).size, 30);
    ck('题单每一行都写着 unique', en.LIBRARY.every((r) => r.proof === 'unique'), en.LIBRARY.filter((r) => r.proof !== 'unique').map((r) => `${r.no}:${r.proof}`).join(','));
    for (const t of en.TIERS) {
      const list = en.byTier(t.key);
      eq(`${t.key} 六局`, list.length, 6);
      eq(`${t.key} 都是 ${t.size.join('×')}`, `${Math.min(...list.map((r) => r.w))}×${Math.max(...list.map((r) => r.h))}`, t.size.join('×'));
      eq(`${t.key} 分数全在实测区间内`, list.filter((r) => r.score < t.band[0] || r.score > t.band[1]).length, 0);
    }
    // Re-derive every shipped row from its own seed with the shipped code, then re-count it with the
    // second implementation. This is the browser-side copy of `node tools/bake.mjs --check`: if a
    // rule weight or a pruning pass moves, the seeds land on different boards and this goes red.
    let same = 0;
    let walkable = 0;
    let proven = 0;
    let worstMs = 0;
    let deepNode = 0;
    const perTier = {};
    for (const r of en.LIBRARY) {
      const p = en.generate(r.seed, en.tierIndexFor(r.tier));
      if (!p) continue;
      if (p.score === r.score && p.steps === r.steps && p.clues === r.clues && p.zeroClues === r.zeroClues && p.w === r.w && p.h === r.h) same++;
      if (en.solve(p.board).ok) walkable++;
      const t0 = performance.now();
      const a = en.analyze({ w: p.w, h: p.h, clue: p.board.clue }, { limit: 2, maxNodes: 500000 });
      const ms = performance.now() - t0;
      worstMs = Math.max(worstMs, ms);
      deepNode = Math.max(deepNode, a.nodes);
      if (a.code === 'unique' && a.exhaustive && a.nodes < 500000) proven++;
      const k = r.tier;
      perTier[k] = perTier[k] || { ms: 0, nodes: 0 };
      perTier[k].ms = Math.max(perTier[k].ms, +ms.toFixed(1));
      perTier[k].nodes = Math.max(perTier[k].nodes, a.nodes);
    }
    eq('种子重导出的分数/步数/线索数一字不差', same, 30);
    eq('三十局全部推得完（零猜测）', walkable, 30);
    eq('三十局的唯一解都在预算内被穷举证完', proven, 30);
    ck('最慢的一局也在半秒内证完', worstMs < 800, `${worstMs.toFixed(1)} ms`);
    ck('最深的一局也远在预算之下', deepNode < 500000, `${deepNode} / 500000`);
    // what the app actually puts on screen for a campaign row
    const g = await open('master', en.byTier('master')[0].seed);
    eq('开局用的就是题单那一局', g.puzzle.originSeed, en.byTier('master')[0].seed);
    eq('面板难度实测等于题单分数', text('#stat-score'), en.byTier('master')[0].score.toFixed(1));
    eq('题单记的推导步数就是盘面脚本长度', g.state().script, en.byTier('master')[0].steps);
    eq('题单记的线索数就是盘面上的线索数', g.board.clues, en.byTier('master')[0].clues);
    A().show('menu');
    await wait(20);
    return report({ worstMs: +worstMs.toFixed(1), deepNode, perTier });
  };

  // ---------- play (menu, panel, controls) ----------
  const play = async () => {
    const en = E();
    await wipe();
    ck('选档页可见', shown('#view-menu'));
    ck('棋局页藏起', !shown('#view-game'));
    eq('标题是视窗', text('#app h1'), '视窗');
    ck('副标题点出玩法', /Tapa/.test(text('.brand .sub')), text('.brand .sub'));
    const tiers = [...document.querySelectorAll('#tier-list .tier')];
    eq('档位按钮五个', tiers.length, 5);
    ck('档位按钮写着盘面尺寸', tiers.every((x) => /×/.test(x.textContent)));
    ck('档位按钮写着实测区间', tiers.every((x) => /实测/.test(x.textContent)));
    let bandOk = true;
    tiers.forEach((x, i) => {
      const t = en.TIERS[i];
      if (!x.textContent.includes(t.size.join('×'))) bandOk = false;
      if (!x.textContent.includes(`实测 ${t.band[0]}–${t.band[1]}`)) bandOk = false;
    });
    ck('档位按钮上的数字就是 TIERS 里的数字', bandOk, tiers.map((x) => (x.textContent.match(/实测 [\d–]+/) || [''])[0]).join(' '));
    eq('玩法说明写了五条规则', document.querySelectorAll('.rules li').length, 5);
    eq('纪录表按档位排', document.querySelectorAll('#record-list li').length, 5);
    ck('空存档时纪录表说还没有纪录', [...document.querySelectorAll('#record-list li')].every((x) => /还没有纪录/.test(x.textContent)));
    ck('页脚写明难度是量出来的', /npm run balance/.test(text('footer')), text('footer'));
    ck('清空存档后不显示继续', !shown('#resume-card'), text('#resume-name'));

    tiers[4].click();
    await wait(120);
    ck('点档位进入棋局', shown('#view-game'));
    ck('进了棋局就离开选档页', shown('#view-game') && !shown('#view-menu'));
    const g = A().game;
    eq('进入的是大师档', g.puzzle.tier, 4);
    eq('棋头写了档位与尺寸', text('#stat-name'), '大师 · 11×11');
    eq('档位徽章', text('#stat-tier'), '大师');
    eq('计时从 00:00 起', text('#stat-time'), '00:00');
    eq('步数为 0', text('#stat-moves'), '0');
    eq('提示为 0', text('#stat-hints'), '0');
    eq('已染黑 0', text('#stat-blacks'), '0');
    eq('已判白 0', text('#stat-whites'), '0');
    eq('待定就是全部格数', text('#stat-remaining'), String(g.board.n));
    eq('对上的数从 0 起', text('#stat-satisfied'), `0/${g.board.clues}`);
    eq('冲突 0', text('#stat-conflicts'), '0');
    eq('难度实测显示分数', text('#stat-score'), g.puzzle.score.toFixed(1));
    ck('胜利遮罩藏起', !shown('#win-veil'));
    eq('状态行开局为空', text('#state-line'), '');
    const geo = A().view.geo;
    const rect = A().view.canvas.getBoundingClientRect();
    ck('画布按棋盘宽铺开', Math.abs(rect.width - (geo.cell * g.w + geo.x * 2)) <= 1, `${rect.width} vs ${geo.cell * g.w + geo.x * 2}`);
    ck('画布按棋盘高铺开', Math.abs(rect.height - (geo.cell * g.h + geo.y * 2)) <= 1, `${rect.height} vs ${geo.cell * g.h + geo.y * 2}`);
    eq('格子边长是整数', Number.isInteger(geo.cell), true);
    ck('格子不小于约定的最小边长', geo.cell >= TH().min, `${geo.cell} >= ${TH().min}`);
    ck('整盘落在视口内', rect.right <= window.innerWidth + 1 && rect.bottom <= window.innerHeight + 1, JSON.stringify({ r: rect.right, b: rect.bottom, vw: window.innerWidth, vh: window.innerHeight }));
    eq('默认画笔是黑', $('#board').dataset.mode, 'black');
    eq('黑按钮按下态', $('#btn-mode-black').getAttribute('aria-pressed'), 'true');
    eq('白按钮未按下', $('#btn-mode-white').getAttribute('aria-pressed'), 'false');

    $('#btn-mode-white').click();
    await wait(30);
    eq('切画笔写进 data-mode', $('#board').dataset.mode, 'white');
    eq('白按钮亮起', $('#btn-mode-white').getAttribute('aria-pressed'), 'true');
    eq('黑按钮熄灭', $('#btn-mode-black').getAttribute('aria-pressed'), 'false');
    for (const [key, want] of [['e', 'erase'], ['b', 'black'], ['w', 'white']]) {
      window.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
      await wait(20);
      eq(`${key} 键换画笔`, $('#board').dataset.mode, want);
    }

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'h', bubbles: true }));
    await wait(60);
    eq('H 键给一次提示', text('#stat-hints'), '1');
    ck('提示理由写出规则名', /^规则：/.test(text('#hint-rule')), text('#hint-rule'));
    ck('提示不是空话', text('#hint-line').length > 8, text('#hint-line'));
    eq('提示按钮角标与面板同步', text('#hint-count'), text('#stat-hints'));
    eq('提示真的落了一格', inkCount(), 1);
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', bubbles: true }));
    await wait(60);
    eq('Z 键退掉提示落的格', inkCount(), 0);
    eq('撤销不退提示次数', text('#stat-hints'), '1');
    eq('撤销退了步数', text('#stat-moves'), '0');

    const wasOn = $('#btn-sound').getAttribute('aria-pressed') === 'true';
    $('#btn-sound').click();
    await wait(30);
    eq('音效按钮改文案', text('#btn-sound'), wasOn ? '音效 关' : '音效 开');
    eq('音效选择进存档', JSON.parse(localStorage.getItem('tapa.save.v1')).settings.sound, !wasOn);
    $('#btn-sound').click();
    $('#btn-motion').click();
    await wait(30);
    eq('动效按钮改文案', text('#btn-motion'), '动效 省');
    ck('减少动效写进 body', document.body.classList.contains('reduce-motion'));
    $('#btn-motion').click();
    await wait(20);
    ck('再点一次恢复动效', !document.body.classList.contains('reduce-motion'));

    $('#btn-new').click();
    await wait(150);
    eq('换一局留在同档', A().game.puzzle.tier, 4);
    eq('换一局清零步数', text('#stat-moves'), '0');
    eq('换一局清零提示', text('#stat-hints'), '0');
    ck('换一局关掉遮罩', !shown('#win-veil'));
    ck('换一局清空状态行', text('#state-line') === '');
    $('#btn-menu').click();
    await wait(60);
    ck('回选档留下可继续的一局', shown('#resume-card'));
    ck('继续卡写着档位', /大师/.test(text('#resume-name')), text('#resume-name'));
    ck('继续卡写着花费', /步 · 提示/.test(text('#resume-meta')), text('#resume-meta'));
    const savedSeed = JSON.parse(localStorage.getItem('tapa.save.v1')).resume.seed;
    $('#btn-resume').click();
    await wait(150);
    ck('继续回到棋局', shown('#view-game'));
    eq('继续用的还是那一局的种子', A().game.puzzle.originSeed, savedSeed);
    $('#btn-menu').click();
    await wait(60);
    window.dispatchEvent(new KeyboardEvent('keydown', { key: '1', bubbles: true }));
    await wait(150);
    eq('1 键进入入门档', A().game.puzzle.tier, 0);
    eq('入门档盘面 5×5', `${A().game.w}×${A().game.h}`, '5×5');
    // the same key on the game view must not restart the run
    const seedNow = A().game.puzzle.originSeed;
    window.dispatchEvent(new KeyboardEvent('keydown', { key: '2', bubbles: true }));
    await wait(60);
    eq('棋局页里数字键不换局', A().game.puzzle.originSeed, seedNow);
    return report({ cell: geo.cell, dpr: geo.dpr, clues: g.board.clues });
  };

  // ---------- ink (the gesture story) ----------
  const ink = async () => {
    const en = E();
    await wipe();
    const g = await open('newbie', 'scen|ink');
    const b = g.board;
    eq('开局没有墨', inkCount(), 0);
    // a tap cycles 未知→黑→白→未知, one engine step each time
    const t = [...Array(b.n).keys()].find((i) => !b.isClue(i) && i > 10);
    ck('找一个没数字的格来点', t > 10, String(t));
    await tap(t);
    eq('点一格落黑', g.valueOf(t), en.BLACK);
    eq('点一格算一步', text('#stat-moves'), '1');
    await tap(t);
    eq('再点同格变白', g.valueOf(t), en.WHITE);
    eq('变白也算一步', text('#stat-moves'), '2');
    await tap(t);
    eq('第三点回到未知', g.valueOf(t), en.UNKNOWN);
    eq('回到未知仍是三步', text('#stat-moves'), '3');
    A().undo();
    await wait(30);
    eq('一次撤销退掉一次点击', text('#stat-moves'), '2');
    // Undo reverses exactly the last action: the third tap wrote 未知 over a 白, so undoing it puts
    // the 白 back — not the 黑 two taps earlier. (js/ui/game.js:115-125 replays step.writes[].from.)
    eq('撤销回到第三点之前的那一色（白）', g.valueOf(t), en.WHITE);

    // a drag paints the brush over everything it covers, and is one step
    const col = [0, 1, 2].map((r) => g.cellAt(0, r));
    A().setMode(en.WHITE);
    await drag(col[0], col[2]);
    eq('一笔竖拖画出三格白', [0, 1, 2].filter((r) => g.valueOf(g.cellAt(0, r)) === en.WHITE).length, 3);
    eq('一笔只算一步', text('#stat-moves'), '3');
    A().undo();
    await wait(30);
    eq('一次撤销退掉整笔', [0, 1, 2].filter((r) => g.valueOf(g.cellAt(0, r)) !== en.UNKNOWN).length, 0);
    eq('撤销也退步数', text('#stat-moves'), '2');

    // mid-gesture the preview is paint, not ink: the panel has not moved yet
    A().setMode(en.BLACK);
    const movesBefore = Number(text('#stat-moves'));
    const blacksBefore = text('#stat-blacks');
    const p0 = at(col[0]);
    const p1 = at(col[1]);
    pointer('pointerdown', p0.x, p0.y);
    pointer('pointermove', p1.x, p1.y);
    await wait(30);
    const previewed = centrePixel(col[1]);
    eq('下笔未收，步数不动', Number(text('#stat-moves')), movesBefore);
    eq('下笔未收，面板读数不动', text('#stat-blacks'), blacksBefore);
    ck('预览不是纯黑（手指下淡了一层）', !near(previewed, hex(TH().ink), 8), JSON.stringify(previewed));
    ck('预览仍比未定亮一点', previewed[0] > hex(TH().surfaceLift)[0], JSON.stringify({ got: previewed, lift: hex(TH().surfaceLift) }));
    pointer('pointerup', p1.x, p1.y);
    await wait(40);
    eq('收笔后两格落黑', [0, 1].filter((r) => g.valueOf(g.cellAt(0, r)) === en.BLACK).length, 2);
    eq('收笔算一步', Number(text('#stat-moves')), movesBefore + 1);
    ck('收笔后画布是纯黑', near(centrePixel(col[1]), hex(TH().ink), 8), JSON.stringify(centrePixel(col[1])));
    eq('面板黑格读数跟上', text('#stat-blacks'), String(Number(blacksBefore) + 2));

    // sweeping back over the anchor must not turn the gesture into a tap
    A().undo();
    await wait(30);
    const moves2 = Number(text('#stat-moves'));
    pointer('pointerdown', p0.x, p0.y);
    pointer('pointermove', p1.x, p1.y);
    pointer('pointermove', p0.x, p0.y);
    pointer('pointerup', p0.x, p0.y);
    await wait(40);
    eq('来回拖仍然写下两格', [0, 1].filter((r) => g.valueOf(g.cellAt(0, r)) === en.BLACK).length, 2);
    eq('来回拖仍然只算一步', Number(text('#stat-moves')), moves2 + 1);

    // the right button is the eraser
    const moves3 = Number(text('#stat-moves'));
    await drag(col[0], col[2], 2);
    eq('右键拖过就把墨擦回未知', [0, 1, 2].filter((r) => g.valueOf(g.cellAt(0, r)) === en.UNKNOWN).length, 3);
    eq('擦这一笔也算一步', Number(text('#stat-moves')), moves3 + 1);
    // The only other ink on the board is cell `t`, which undo left on 白 — so a clean sweep really
    // does put the black readout back to 0, not to 1.
    eq('擦干净后黑格读数归位', text('#stat-blacks'), '0');

    // a press outside the board does nothing
    const c = A().view.canvas.getBoundingClientRect();
    const geo = A().view.geo;
    const moves4 = Number(text('#stat-moves'));
    pointer('pointerdown', c.left - 6, c.top + 6);
    pointer('pointerup', c.left - 6, c.top + 6);
    await wait(30);
    eq('画布外的按下不落子', Number(text('#stat-moves')), moves4);
    pointer('pointerdown', c.left + geo.x - 1, c.top + geo.y + 2);
    pointer('pointerup', c.left + geo.x - 1, c.top + geo.y + 2);
    await wait(30);
    eq('盘框外那一圈留白也不落子', Number(text('#stat-moves')), moves4);

    // tapping a clue cell is allowed, and the first tap is the right colour: rule 2 says so
    const clued = b.clued.find((i) => !en.isZeroClue(b.clue[i]));
    ck('这盘上有带数字的格', clued >= 0, String(clued));
    await tap(clued);
    eq('点线索格落黑（与规则一致）', g.valueOf(clued), en.BLACK);
    eq('这一步不冲突', text('#stat-conflicts'), '0');
    await tap(clued);
    eq('再点变白就是错', g.valueOf(clued), en.WHITE);
    eq('错一步就被点名一次', text('#stat-conflicts'), '1');
    // What the state line actually says, in the app's own words (js/main.js:128-132): a white on a
    // clue cell is not just a mismatch the pencil path can live with — it proves no completion
    // exists, so the line makes the stronger claim and the count rides on #stat-conflicts above.
    ck('状态行说出这一盘已经和数字矛盾', /已经和数字矛盾了/.test(text('#state-line')), text('#state-line'));
    ck('状态行此刻不报处数', !/\d+ 处对不上/.test(text('#state-line')), text('#state-line'));
    ck('冲突读数被标成警示色', $('#stat-conflicts').closest('.stat').classList.contains('bad'));
    eq('对上的数字也跟着变', text('#stat-satisfied'), `0/${b.clues}`);
    await tap(clued);
    eq('擦回未知后不再罚', g.valueOf(clued), en.UNKNOWN);
    eq('擦回未知后冲突归零', text('#stat-conflicts'), '0');
    eq('状态行也清空', text('#state-line'), '');

    // win by playing the engine's own answer through the real gesture path
    await open('newbie', 'scen|ink-win');
    const g2 = A().game;
    for (let i = 0; i < g2.board.n; i++) A().stroke([i], g2.puzzle.solution[i]);
    await wait(40);
    eq('一格一格照解画就能胜', g2.status, 'won');
    eq('纯手工通关不用提示', g2.hints, 0);
    eq('手工通关的步数等于格数', g2.moves, g2.board.n);
    ck('胜利遮罩出现', shown('#win-veil'));
    ck('胜利文案写 0 次提示', /提示 0 次/.test(text('#win-meta')), text('#win-meta'));
    ck('手工通关写下纪录', !!en.Store.best('newbie'), JSON.stringify(en.Store.best('newbie')));
    ck('终局把格子画成绿的', near(centrePixel(g2.cellAt(1, 1)), hex(TH().success), 12), JSON.stringify(centrePixel(g2.cellAt(1, 1))));
    await open('newbie', 'scen|ink-win2');
    const g3 = A().game;
    for (let i = 0; i < g3.board.n; i++) A().stroke([i], en.BLACK);
    await wait(40);
    eq('满盘皆黑不算通关', g3.status, 'playing');
    eq('满盘皆黑待定归零', text('#stat-remaining'), '0');
    ck('满盘皆黑被大量点名', Number(text('#stat-conflicts')) > 5, text('#stat-conflicts'));
    return report({ moves: g2.moves, cell: geo.cell });
  };

  // ---------- hint (walk a whole board with the hints only) ----------
  const hint = async () => {
    const en = E();
    await wipe();
    const g = await open('hard', 'scen|hint');
    const b = g.board;
    eq('提示局开局干净', inkCount(), 0);
    const names = new Set(Object.values(en.Rules).map((r) => r.name));
    const seen = new Set();
    let charged = 0;
    let badRule = 0;
    let outOfRange = 0;
    let notWritten = 0;
    let badWhy = 0;
    let panelWrong = 0;
    for (let k = 0; k < 200 && g.status !== 'won'; k++) {
      const info = A().useHint();
      if (!info) break;
      if (info.stalled) {
        ck('推完之前不喊停', false, info.text);
        break;
      }
      if (info.conflict) {
        ck('一路提示不该撞到自己的墨', false, info.conflict);
        break;
      }
      charged++;
      seen.add(info.rule);
      if (!names.has(info.rule)) badRule++;
      if (!(info.cell >= 0 && info.cell < b.n)) outOfRange++;
      if (g.valueOf(info.cell) !== info.value) notWritten++;
      if (!info.why.includes(b.name(info.cell))) badWhy++;
      if (text('#hint-line') !== info.why) panelWrong++;
      if (text('#hint-rule') !== `规则：${info.rule}`) panelWrong++;
    }
    eq('一路提示能走完这局', g.status, 'won');
    eq('提示次数等于格数', charged, b.n);
    eq('提示说的规则都在规则表里', badRule, 0);
    eq('提示不越界', outOfRange, 0);
    eq('提示说完就真落子', notWritten, 0);
    eq('提示的理由点出它写的那一格', badWhy, 0);
    eq('面板逐条跟着提示走', panelWrong, 0);
    ck('用到的规则不止两种', seen.size >= 2, [...seen].join(','));
    eq('手工步数没被提示冒充', text('#stat-moves'), '0');
    eq('终局通过独立验收', en.verify(b, g.st.cell).length, 0);
    eq('每个数字都对上了', g.state().satisfied, g.state().clues);
    ck('胜利遮罩可见', shown('#win-veil'));
    ck('胜利文案带花费', /步 · 提示 \d+ 次/.test(text('#win-meta')), text('#win-meta'));
    eq('胜利文案的提示次数与实际一致', text('#win-meta').match(/提示 (\d+) 次/)[1], text('#stat-hints'));
    eq('胜利文案的步数与面板一致', text('#win-meta').match(/ (\d+) 步/)[1], text('#stat-moves'));
    const after = g.hints;
    A().useHint();
    eq('胜利后再按提示不充电', g.hints, after);
    eq('胜利后续局被清掉', en.Store.resume(), null);

    // the pulse a hint leaves must ring the cell it just named, and nothing else
    const g2 = await open('newbie', 'scen|hint-pulse');
    const info2 = A().useHint();
    await wait(30);
    const pulsed = onPulseRect(info2.cell, TH().hint, 26);
    const dc = (i) => Math.abs((i % g2.w) - (info2.cell % g2.w));
    const dr = (i) => Math.abs((((i / g2.w) | 0)) - (((info2.cell / g2.w) | 0)));
    const control = [...Array(g2.board.n).keys()].find((i) => dc(i) > 1 && dr(i) > 1);
    ck('提示把刚点出的那一格圈出来', pulsed >= 8, `圈线采样 ${pulsed}/32 @${g2.board.name(info2.cell)}`);
    eq('别的格没有被圈（对照）', onPulseRect(control, TH().hint, 26), 0);
    eq('提示框说的是规则而不是答案', text('#hint-rule'), `规则：${info2.rule}`);
    eq('提示说的是哪一格落哪一色', text('#hint-line'), info2.why);
    await wait(1700); // the pulse fades out; the picture must go back to plain ink
    eq('脉冲淡出后不留蓝（对照）', onPulseRect(info2.cell, TH().hint, 26), 0);
    ck('淡出后那一格还是墨色', near(centrePixel(info2.cell), hex(info2.value === en.BLACK ? TH().ink : TH().bgBottom), 8), JSON.stringify({ got: centrePixel(info2.cell), value: info2.value }));

    // a second board must not be walkable by reusing the first one's script
    const g3 = await open('hard', 'scen|hint2');
    eq('换局后脚本重来', g3.cursor, 0);
    eq('换局后提示清零', g3.hints, 0);
    eq('换局后格子是空的', inkCount(), 0);
    return report({ hints: charged, rules: [...seen], cells: b.n });
  };

  // ---------- conflict ----------
  const conflict = async () => {
    const en = E();
    await wipe();
    const g = await open('medium', 'scen|conflict');
    const b = g.board;
    const first = g.script[0];
    eq('第一条能推的是线索自黑', first.rule.key, 'selfBlack');
    const wrong = first.value === en.BLACK ? en.WHITE : en.BLACK;
    A().stroke([first.cell], wrong);
    await wait(40);
    eq('玩家落了与线索相反的一格', g.valueOf(first.cell), wrong);
    const info = A().useHint();
    ck('提示拒绝落子', !!info.conflict, JSON.stringify(info));
    eq('矛盾时不收钱', text('#stat-hints'), '0');
    ck('矛盾说明点出该落哪一色', /必须是(黑|白)/.test(info.conflict), info.conflict);
    ck('矛盾说明点名那一格', info.conflict.includes(b.name(first.cell)), info.conflict);
    ck('这条墨被证明无路可走', g.state().stuck === true, JSON.stringify(g.state()));
    ck('状态行说出矛盾', /矛盾/.test(text('#state-line')), text('#state-line'));
    ck('待定读数被标成警示色', $('#stat-remaining').closest('.stat').classList.contains('bad'));
    eq('提示框说的是矛盾而不是答案', text('#hint-rule'), '这里和线索矛盾');
    ck('矛盾时画布点出错格', onPulseRect(first.cell, TH().error, 30) >= 8, String(onPulseRect(first.cell, TH().error, 30)));
    A().stroke([first.cell], en.UNKNOWN);
    await wait(40);
    eq('擦掉错墨之后矛盾消失', g.state().stuck, false);
    eq('状态行也清空', text('#state-line'), '');
    eq('这时提示才肯落子', A().useHint().value, first.value);
    eq('这次才计一次提示', text('#stat-hints'), '1');
    eq('落的就是线索要的那一色', g.valueOf(first.cell), first.value);
    ck('落子后画布上是墨或白', near(centrePixel(first.cell), hex(first.value === en.BLACK ? TH().ink : TH().bgBottom), 8), JSON.stringify(centrePixel(first.cell)));

    // the 2×2 and connectivity faults reach the panel as numbers, not as prose
    await open('hard', 'scen|conflict2');
    const g2 = A().game;
    A().stroke([...Array(g2.board.n).keys()], en.BLACK);
    await wait(80);
    eq('满盘皆黑不误判胜利', g2.status, 'playing');
    eq('待定归零', text('#stat-remaining'), '0');
    eq('面板冲突读数与引擎一致', text('#stat-conflicts'), String(g2.state().problems));
    ck('每个二乘二都被算进去了', g2.state().blocks === (g2.w - 1) * (g2.h - 1), `${g2.state().blocks} vs ${(g2.w - 1) * (g2.h - 1)}`);
    eq('满盘皆黑时一条数字都没对上', g2.state().satisfied, 0);
    ck('状态行数得出对不上的处数', /^\d+ 处对不上/.test(text('#state-line')), text('#state-line'));
    eq('状态行的处数就是冲突读数', text('#state-line').match(/(\d+) 处对不上/)[1], text('#stat-conflicts'));
    ck('说明列出了三种破法', /二乘二/.test(text('#state-line')) && /围死/.test(text('#state-line')) && /段数/.test(text('#state-line')), text('#state-line'));
    // the engine's own answer, drawn through the same path, must have no fault at all
    await open('hard', 'scen|conflict3');
    const g3 = A().game;
    for (let i = 0; i < g3.board.n; i++) A().stroke([i], g3.puzzle.solution[i]);
    await wait(80);
    eq('照解画完时冲突为 0', text('#stat-conflicts'), '0');
    eq('照解画完时所有数字都凑齐', text('#stat-satisfied'), `${g3.state().clues}/${g3.state().clues}`);
    eq('照解画完就赢了', g3.status, 'won');
    const a3 = en.analyze({ w: g3.w, h: g3.h, clue: g3.board.clue }, { limit: 2, maxNodes: 500000 });
    eq('穷举计数器认这一局唯一', a3.code, 'unique');
    eq('穷举的解与玩家画完的解同盘', Array.from(a3.forced).join(','), Array.from(g3.st.cell).join(','));
    const off = Int8Array.from(g3.puzzle.solution);
    off[1] = off[1] === en.BLACK ? en.WHITE : en.BLACK;
    ck('差一格就通不过独立验收', en.verify(g3.board, off).length >= 1, JSON.stringify(en.verify(g3.board, off).map((x) => x.kind)));
    ck('差的那一格也被证明无路可走', !en.reachable(g3.board, off) || en.verify(g3.board, off).length >= 1, JSON.stringify({ stuck: !en.reachable(g3.board, off) }));
    return report({ problems: g2.state().problems, blocks: g2.state().blocks, nodes: a3.nodes });
  };

  // ---------- zero (`0 0 0` must not be confusable with "no clue here") ----------
  const zero = async () => {
    const en = E();
    await wipe();
    const row = en.byTier('newbie').find((r) => r.zeroClues > 0);
    ck('题单里有带 0 0 0 的一局', !!row);
    const g = await open('newbie', row.seed);
    const b = g.board;
    eq('题单记下的 0 0 0 个数与盘面一致', b.zeroClues, b.clued.filter((i) => en.isZeroClue(b.clue[i])).length);
    ck('盘面上确实有 0 0 0', b.zeroClues >= 1, String(b.zeroClues));
    const zc = b.clued.find((i) => en.isZeroClue(b.clue[i]));
    const pc = b.clued.find((i) => !en.isZeroClue(b.clue[i]));
    const uc = [...Array(b.n).keys()].find((i) => !b.isClue(i));
    ck('三种状态都在这盘上', zc >= 0 && pc >= 0 && uc >= 0, JSON.stringify({ zc, pc, uc }));
    eq('0 0 0 的读法是三个零', b.digits(zc).join(','), '0,0,0');
    eq('有数字的格读出的不是三个零', b.digits(pc).join(','), en.clueDigits(b.clue[pc]).join(','));
    eq('无线索的格什么都不读', b.digits(uc).length, 0);
    // the picture: a dashed teal hoop over the `0 0 0` cell, and only there
    const hoopZero = onCircle(zc, 0.3, TH().zeroClue, 22, 24);
    const hoopClue = onCircle(pc, 0.3, TH().zeroClue, 22, 24);
    const hoopNone = onCircle(uc, 0.3, TH().zeroClue, 22, 24);
    ck('0 0 0 那一格画得出虚线环', hoopZero >= 8, `虚线采样 ${hoopZero}/24 @${b.name(zc)}`);
    eq('带数字的格没有那圈虚线（对照）', hoopClue, 0);
    eq('没数字的格也没有那圈虚线（对照）', hoopNone, 0);
    // and its three zeros are painted in teal, where an ordinary clue's digits are amber
    ck('0 0 0 的数字真的画出来了', glyphInk(zc, 0, TH().zeroClue, 40) >= 4, String(glyphInk(zc, 0, TH().zeroClue, 40)));
    ck('普通线索的数字用琥珀色', glyphInk(pc, 0, TH().accent, 40) >= 4, String(glyphInk(pc, 0, TH().accent, 40)));
    eq('普通线索的位子上没有青色数字', glyphInk(pc, 0, TH().zeroClue, 30), 0);
    eq('0 0 0 的位子上没有琥珀色数字', glyphInk(zc, 0, TH().accent, 30), 0);
    eq('没数字的位子上什么数字也没有', glyphInk(uc, 0, TH().accent, 40), 0);
    // the cell's own colour: a `0 0 0` cell is white, a clued cell is black (rule 2)
    A().stroke([zc], en.WHITE);
    A().stroke([pc], en.BLACK);
    await wait(40);
    eq('两格都落对了，没有冲突', g.state().conflicts, 0);
    ck('0 0 0 的格子画成白', near(centrePixel(zc), hex(TH().bgBottom), 8), JSON.stringify(centrePixel(zc)));
    ck('带数字的格子画成黑', near(centrePixel(pc), hex(TH().ink), 8), JSON.stringify(centrePixel(pc)));
    ck('没定的格子画成第三种颜色', near(centrePixel(uc), hex(TH().surfaceLift), 8), JSON.stringify(centrePixel(uc)));
    ck('虚线环在落墨之后仍然只在 0 0 0 上', onCircle(zc, 0.3, TH().zeroClue, 22, 24) >= 8 && onCircle(pc, 0.3, TH().zeroClue, 22, 24) === 0, JSON.stringify({ z: onCircle(zc, 0.3, TH().zeroClue, 22, 24), p: onCircle(pc, 0.3, TH().zeroClue, 22, 24) }));
    // the sentinel, stated as data
    eq('0 是合法的线索值，不是哨兵', `${en.isZeroClue(0)},${en.NO_CLUE !== 0}`, 'true,true');
    eq('满白盘的 3×3 每格都能写 0 0 0', en.cluesFrom(3, 3, new Int8Array(9).fill(en.WHITE)).includes(en.NO_CLUE), false);
    const zBoard = en.createBoard(3, 3, (() => { const a = new Int16Array(9).fill(en.NO_CLUE); a[4] = 0; return a; })());
    const zz = en.solve(zBoard);
    eq('0 0 0 把盘心判白', zz.derived[4], en.WHITE);
    eq('0 0 0 把八邻也判白', Array.from(zz.derived).filter((v) => v === en.WHITE).length, 9);
    const nBoard = en.createBoard(3, 3, (() => { const a = new Int16Array(9).fill(en.NO_CLUE); a[4] = en.encodeClue(1); return a; })());
    eq('把 0 当哨兵就会吞掉这条线索', en.clueDigits(en.NO_CLUE).length, 0);
    ck('两种状态在引擎里也是两种状态', en.isZeroClue(0) && !en.isZeroClue(en.NO_CLUE));
    // and on the menu, in prose, the same distinction is stated the same way
    ck('选档页把 0 0 0 讲成一句证词', /0 0 0/.test(text('#view-menu p')), text('#view-menu p').slice(0, 40));
    ck('图例里有虚线环那一项', [...document.querySelectorAll('.legend span')].some((x) => /0 0 0 的虚线环/.test(x.textContent)));
    return report({ zeroClues: b.zeroClues, hoopZero, hoopClue, hoopNone });
  };

  // ---------- save ----------
  const save = async () => {
    const en = E();
    await wipe();
    const g = await open('medium', 'scen|save');
    const b = g.board;
    for (let i = 0; i < 6; i++) A().stroke([i], g.puzzle.solution[i]);
    A().useHint();
    await wait(40);
    eq('存档键名', en.Store._key, 'tapa.save.v1');
    eq('存档只有这四块', Object.keys(JSON.parse(localStorage.getItem(en.Store._key))).sort().join(','), 'best,resume,settings,totals');
    const raw = JSON.parse(localStorage.getItem('tapa.save.v1'));
    ck('存档里有续局', !!raw.resume, Object.keys(raw).join(','));
    eq('存档写原始种子', raw.resume.seed, g.puzzle.originSeed);
    eq('存档写档位索引', raw.resume.tier, g.puzzle.tier);
    eq('存档写格数', raw.resume.cells, b.n);
    eq('存档写步数', raw.resume.moves, g.moves);
    eq('存档写提示数', raw.resume.hints, g.hints);
    ck('存档写用时', raw.resume.elapsedMs > 0, String(raw.resume.elapsedMs));
    const bytes = JSON.stringify(raw.resume).length;
    ck('49 格的续局不过四百字节', bytes < 400, `${bytes} bytes`);
    const back = en.Store.resume();
    eq('墨一格不差地回来', Array.from(back.board).join(','), Array.from(g.st.cell).join(','));
    ck('没定的格在存档里还是没定', back.board.some((v) => v === en.UNKNOWN) && Array.from(back.board).every((v) => v >= 0 && v <= 2), Array.from(back.board).join('').slice(0, 12));
    ck('游程编码比一格一值省', back.ink.length < b.n * 2, `${back.ink.length} 段 vs ${b.n * 2}`);
    eq('未知在存档线上是 0', en.Store._rle.toWire(en.UNKNOWN), 0);
    eq('黑在存档线上是 1', en.Store._rle.toWire(en.BLACK), 1);
    eq('线上 0 解码回未知（不是白）', en.Store._rle.fromWire(0), en.UNKNOWN);
    eq('坏游程被跳过、缺的补成未知', Array.from(en.Store._rle.decode([1, 3, 7, 2], 8)).join(','), '1,1,1,2,2,2,2,2');
    eq('格数不符的存档不肯装这盘', en.Store.resumeBoard(b.n + 1), null);
    ck('格数相符时取回盘面', !!en.Store.resumeBoard(b.n));
    eq('默认设置音效开', en.Store.setting('sound'), true);
    eq('默认不设减少动效', en.Store.setting('reduceMotion'), false);
    ck('本作不读别的作品的设置', !('showNotes' in raw.settings), JSON.stringify(raw.settings));
    // hostile payloads: a save that cannot be understood is discarded, never half-trusted
    const keep = localStorage.getItem('tapa.save.v1');
    const junk = ['{', '[]', 'null', '"x"', '0', JSON.stringify({ resume: { cells: 0, ink: [1, 2], tier: 3 } }), JSON.stringify({ resume: { cells: 49, ink: 'ink', tier: 3 } }), JSON.stringify({ best: { medium: { ms: 'soon' } }, settings: 7 })];
    let survived = 0;
    for (let k = 0; k < junk.length; k++) {
      localStorage.setItem('tapa.save.v1', junk[k]);
      const F = (await import(`/js/store.js?hostile=${k}&n=${Date.now()}`)).Store;
      if (F.resume() === null && Object.keys(F.data.best).length === 0 && F.setting('sound') === true && F.data.totals.solved === 0 && F.setting('reduceMotion') === false) survived++;
    }
    eq('八种坏存档一律整份丢弃', survived, junk.length);
    localStorage.setItem('tapa.save.v1', JSON.stringify({ resume: { seed: 'keep|me', cells: 9, ink: [0, 9], tier: 0, moves: 3, hints: 1, elapsedMs: 5000 } }));
    const good = (await import(`/js/store.js?shape=${Date.now()}`)).Store;
    eq('形状对的存档才被接受', good.resume().seed, 'keep|me');
    eq('续局带回九格', good.resume().board.length, 9);
    eq('续局带回步数', good.resume().moves, 3);
    eq('续局带回提示数', good.resume().hints, 1);
    localStorage.setItem('tapa.save.v1', keep);
    eq('试完坏存档还能恢复原局', JSON.parse(localStorage.getItem('tapa.save.v1')).resume.seed, g.puzzle.originSeed);
    // a localStorage that throws on the *getter* (Safari in private mode) must not take the page down
    const realLS = window.localStorage;
    let threw = false;
    try {
      Object.defineProperty(window, 'localStorage', {
        configurable: true,
        get() {
          throw new Error('Safari in private mode');
        },
      });
      const N = (await import(`/js/store.js?throwing=${Date.now()}`)).Store;
      threw = N.resume() === null && N.setting('sound') === true;
      N.save();
      N.saveResume(g.puzzle, g.st.cell, 1000, { moves: 1, hints: 1 });
      N.clearResume();
      threw = threw && N.resume() === null;
    } finally {
      delete window.localStorage;
      Object.defineProperty(window, 'localStorage', { value: realLS, configurable: true, writable: true });
    }
    ck('localStorage 取值就抛时也只是忘记', threw);
    ck('页面还活着', !!A().game && A().version === '1.0.0', A().version);
    // records rank by least help taken, not by fastest clock
    const solvedBefore = en.Store.data.totals.solved;
    en.Store.recordSolve(1000, 2);
    eq('总局数按局累加', en.Store.data.totals.solved, solvedBefore + 1);
    ck('累计提示在涨', en.Store.data.totals.hints >= 2, String(en.Store.data.totals.hints));
    en.Store.data.best = {};
    eq('首个纪录直接成立', en.Store.recordBest('medium', { ms: 50000, hints: 1, moves: 20, size: '7×7' }), true);
    eq('更快但更靠提示的不算破纪录', en.Store.recordBest('medium', { ms: 1000, hints: 2, moves: 5, size: '7×7' }), false);
    eq('同求助次数下省步算破纪录', en.Store.recordBest('medium', { ms: 60000, hints: 1, moves: 12, size: '7×7' }), true);
    eq('步数也相同时才比时间', en.Store.recordBest('medium', { ms: 90000, hints: 1, moves: 12, size: '7×7' }), false);
    eq('纪录留的是最好的那次', en.Store.best('medium').moves, 12);
    en.Store.data.best = {};
    A().show('menu');
    await wait(30);
    ck('纪录清空后面板说还没有纪录', [...document.querySelectorAll('#record-list li')].every((x) => /还没有纪录/.test(x.textContent)));
    A().show('game');
    await wait(30);
    eq('存进去的纪录与 localStorage 一致', JSON.parse(localStorage.getItem(en.Store._key)).resume.cells, b.n);
    return report({ bytes, runs: raw.resume.ink.length, cells: b.n });
  };

  // ---------- resume ----------
  const resume = async () => {
    const en = E();
    await wipe();
    const g = await open('hard', 'scen|resume');
    const clueBefore = Array.from(g.board.clue).join(',');
    for (let i = 0; i < 8; i++) A().stroke([i], g.puzzle.solution[i]);
    A().useHint();
    A().useHint();
    await wait(40);
    const saved = { cell: Array.from(g.st.cell).join(','), moves: g.moves, hints: g.hints };
    const elapsed = A().elapsed();
    A().show('menu');
    await wait(60);
    ck('回选档留下继续卡', shown('#resume-card'));
    ck('继续卡写着档位', /困难/.test(text('#resume-name')), text('#resume-name'));
    ck('继续卡写着花费', /步 · 提示 2 次/.test(text('#resume-meta')), text('#resume-meta'));
    const r = en.Store.resume();
    eq('续局取回全部墨', Array.from(r.board).join(','), saved.cell);
    $('#btn-resume').click();
    await wait(150);
    const g2 = A().game;
    ck('继续回到棋局页', shown('#view-game'));
    eq('续局重绘出同一块盘', Array.from(g2.board.clue).join(','), clueBefore);
    eq('续局还原全部墨', Array.from(g2.st.cell).join(','), saved.cell);
    eq('续局还原步数', g2.moves, saved.moves);
    eq('续局还原提示数', g2.hints, saved.hints);
    eq('面板显示还原后的提示', text('#stat-hints'), String(saved.hints));
    eq('面板显示还原后的步数', text('#stat-moves'), String(saved.moves));
    ck('续局接着计时', A().elapsed() >= elapsed, `${A().elapsed()} vs ${elapsed}`);
    eq('面板已染黑与引擎一致', text('#stat-blacks'), String(g2.state().blacks));
    eq('续局不能撤销到重开之前', A().undo(), null);
    eq('撤销失败也不动墨', Array.from(g2.st.cell).join(','), saved.cell);
    const res = A().solveWithLogic();
    eq('续局可以推到胜利', g2.status, 'won', JSON.stringify(res));
    ck('推到底用了逻辑', res.steps > 1, String(res.steps));
    eq('胜利时格子全落定', g2.state().remaining, 0);
    ck('破纪录按求助最少记', !en.Store.best('hard') || en.Store.best('hard').hints <= g2.hints, JSON.stringify(en.Store.best('hard')));
    eq('胜利后续局被清掉', en.Store.resume(), null);
    ck('胜利遮罩可见', shown('#win-veil'));
    $('#btn-menu-2').click();
    await wait(60);
    ck('胜利后回选档不再给继续', !shown('#resume-card'));
    ck('胜利后纪录表有东西', [...document.querySelectorAll('#record-list li')].some((x) => !/还没有纪录/.test(x.textContent)));
    eq('纪录表写的提示次数与实际一致', text('#record-list li[data-tier="hard"]').match(/提示 (\d+)/)[1], String(g2.hints));
    ck('总局数累加了', en.Store.data.totals.solved >= 1, String(en.Store.data.totals.solved));

    // a save from a board of another size is dropped whole, not painted sideways onto this one
    en.Store.saveResume({ originSeed: 'foreign|5x5', tier: 0, w: 5, h: 5 }, new Int8Array(25).fill(en.BLACK), 10, { moves: 5, hints: 5 });
    const foreign = en.Store.resume();
    eq('5×5 的存档装不进 9×9 的盘', en.Store.resumeBoard(g2.board.n), null);
    const g3 = A().begin({ tier: 'hard', seed: 'scen|resume', resume: foreign });
    await wait(80);
    eq('格子对不上就整份丢掉（不画歪盘）', Array.from(g3.st.cell).every((v) => v === en.UNKNOWN), true);
    eq('丢掉的存档不带走花费', `${g3.moves},${g3.hints}`, '0,0');
    eq('同一个种子重开还是同一块盘', Array.from(g3.board.clue).join(','), clueBefore);
    $('#btn-reset').click();
    await wait(60);
    eq('清空存档清掉纪录', en.Store.best('hard'), null);
    ck('清空存档回到选档', shown('#view-menu'));
    eq('清空后续档也没了', en.Store.resume(), null);
    eq('清空存档真的写掉了 localStorage', localStorage.getItem('tapa.save.v1'), null);
    return report({ restored: saved.cell.split(',').filter((v) => v !== '2').length, hints: saved.hints, moves: saved.moves });
  };

  // ---------- layout (geometry, the 11×11, and the readouts the picture has to support) ----------
  const layout = async () => {
    const en = E();
    await wipe();
    const g = await open('master', en.byTier('master')[0].seed);
    const b = g.board;
    const view = A().view;
    const box = view.canvas.getBoundingClientRect();
    const wrap = $('#board-wrap').getBoundingClientRect();
    const geo = view.geo;
    ck('11×11 落在视口里', box.right <= window.innerWidth + 1 && box.bottom <= window.innerHeight + 1, JSON.stringify({ r: box.right, b: box.bottom, vw: window.innerWidth, vh: window.innerHeight }));
    ck('画布不溢出 main', box.right <= $('main').getBoundingClientRect().right + 1, `${box.right} vs ${$('main').getBoundingClientRect().right}`);
    eq('棋盘容器就是画布大小', Math.round(wrap.width), Math.round(box.width));
    ck('格子边长在约定的区间里', geo.cell >= TH().min && geo.cell <= TH().max, `${geo.cell} in [${TH().min},${TH().max}]`);
    eq('缓冲区按 dpr 放大', view.canvas.width, Math.round(geo.w * geo.dpr));
    eq('CSS 尺寸写进 style', view.canvas.style.width, `${geo.w}px`);
    // every cell is clickable where it is drawn — the one place layout and hit-testing must agree
    let missed = 0;
    for (let t = 0; t < b.n; t++) {
      const p = at(t);
      if (view.hitCell(p.x, p.y) !== t) missed++;
    }
    eq('每格点中心都命中自己', missed, 0);
    let edgeMiss = 0;
    for (const t of [0, b.w - 1, b.n - b.w, b.n - 1, 3 * b.w + 3]) {
      const r = view.cellRect(t);
      for (const xy of [[1, r.size / 2], [r.size - 1, r.size / 2], [r.size / 2, 1], [r.size / 2, r.size - 1]]) {
        if (view.hitCell(box.left + r.x + xy[0], box.top + r.y + xy[1]) !== t) edgeMiss++;
      }
    }
    eq('格子四边内侧一像素仍命中本格', edgeMiss, 0);
    eq('盘外一像素不落子', view.hitCell(box.left + geo.x - 1, box.top + geo.y + 2), -1);
    eq('画布左上留白外不落子', view.hitCell(box.left - 1, box.top + 2), -1);
    // the digits are actually painted, on the plate at each direction slot
    const sample = b.clued.slice(0, 8);
    let painted = 0;
    for (const i of sample) {
      if (glyphInk(i, 0, TH().accent, 60) >= 4 || glyphInk(i, 0, TH().zeroClue, 60) >= 4) painted++;
    }
    eq('抽样八条线索的数字都画出来了', painted, sample.length);
    ck('这一盘的数字少于格数（不是一整盘答案）', b.clued.length < b.n, `${b.clued.length}/${b.n}`);
    // eight directions get eight anchors: a clue's first digit is north of its own cell
    const north = view.slotPoint(sample[0], 0);
    const own = view.cellRect(sample[0]);
    ck('第一个数字画在格子北侧', north.y < own.y + own.size / 2, JSON.stringify({ slot: north, cell: own }));
    // legend, keyhint and stats: the panel has to describe the picture it ships
    eq('图例六项', document.querySelectorAll('.legend span').length, 6);
    ck('图例的黑与画布的黑同色', near(rgb(getComputedStyle($('.sw-ink')).backgroundColor), hex(TH().ink), 6), `${rgb(getComputedStyle($('.sw-ink')).backgroundColor).join(',')} vs ${TH().ink}`);
    ck('图例的 0 0 0 与画布同色', near(rgb(getComputedStyle($('.sw-zero')).backgroundColor), hex(TH().zeroClue), 6), `${rgb(getComputedStyle($('.sw-zero')).backgroundColor).join(',')} vs ${TH().zeroClue}`);
    ck('图例的白与画布的白同色', near(rgb(getComputedStyle($('.sw-white')).backgroundColor), hex(TH().bgBottom), 6), `${rgb(getComputedStyle($('.sw-white')).backgroundColor).join(',')} vs ${TH().bgBottom}`);
    ck('操作提示讲清手势', /点击/.test(text('.keyhint')) && /拖动/.test(text('.keyhint')) && /撤销/.test(text('.keyhint')), text('.keyhint'));
    eq('统计项八条', document.querySelectorAll('.stats .stat').length, 8);
    eq('触摸最小尺寸写进 CSS 变量', cssVar('--touch-min'), '44px');
    const heights = [...document.querySelectorAll('#app button')].map((x) => Math.round(x.getBoundingClientRect().height));
    ck('所有按钮都够点', heights.every((h) => h >= 44), `最矮 ${Math.min(...heights)}px`);
    ck('画笔三档并排不重叠', (() => {
      const bs = [...document.querySelectorAll('.modes button')].map((x) => x.getBoundingClientRect());
      for (let i = 1; i < bs.length; i++) if (bs[i].left < bs[i - 1].right - 1) return false;
      return true;
    })());
    ck('提示框不横向溢出', $('.hint-box').scrollWidth <= $('.hint-box').clientWidth + 1, `${$('.hint-box').scrollWidth} vs ${$('.hint-box').clientWidth}`);
    // the satisfied-clue ring: green where the numbers add up, nothing where they don't.
    // Painted from the answer so the state is deterministic rather than "however far the hints got".
    const target = b.clued.find((i) => b.rings[i].length === 8);
    A().stroke([target, ...Array.from(b.rings[target])], en.WHITE);
    for (const c of b.rings[target]) A().stroke([c], g.puzzle.solution[c]);
    A().stroke([target], en.BLACK);
    await wait(60);
    ck('有一条数字对上了', g.diag.satisfied.has(target), String(g.state().satisfied));
    const notSat = b.clued.find((i) => !g.diag.satisfied.has(i) && !g.diag.violated.has(i) && Math.abs((i % b.w) - (target % b.w)) > 1);
    ck('还有数字没对上（对照格找得到）', notSat >= 0, String(notSat));
    await wait(1700); // let any hint pulse fade out before sampling the picture
    const ringSat = onCircle(target, 0.44, TH().success, 24, 12);
    const ringOpen = onCircle(notSat, 0.44, TH().success, 24, 12);
    ck('对上的数字画了绿环', ringSat >= 4, `绿环采样 ${ringSat}/12 @${b.name(target)}`);
    eq('没对上的数字没有绿环（对照）', ringOpen, 0);
    eq('面板的对上数与画布一致', text('#stat-satisfied'), `${g.state().satisfied}/${b.clues}`);
    // win card geometry, on the biggest board the game ships
    const res = A().solveWithLogic();
    await wait(80);
    ck('胜利卡出现', shown('#win-veil'));
    eq('11×11 全盘 121 格推完', g.state().script, 121);
    eq('脚本长度就是这一局的推导步数', g.state().script, en.byTier('master')[0].steps);
    ck('胜利卡居中在棋盘内', (() => {
      const card = $('.win-card').getBoundingClientRect();
      return card.left >= wrap.left - 1 && card.right <= wrap.right + 1 && card.top >= wrap.top - 1 && card.bottom <= wrap.bottom + 1;
    })(), JSON.stringify({ c: $('.win-card').getBoundingClientRect(), w: $('#board-wrap').getBoundingClientRect() }));
    ck('胜利按钮点得到', $('#btn-again').getBoundingClientRect().width > 40);
    ck('终局把整片格子画成绿的', near(centrePixel(b.cellAt(5, 5)), hex(TH().success), 12), JSON.stringify(centrePixel(b.cellAt(5, 5))));
    ck('终局也画不出界', A().view.canvas.getBoundingClientRect().bottom <= window.innerHeight + 1, String(A().view.canvas.getBoundingClientRect().bottom));
    return report({ cell: geo.cell, dpr: geo.dpr, clues: b.clues, hints: g.hints, steps: res.steps });
  };

  w.__sc = { engine, gen, library, play, ink, hint, conflict, zero, save, resume, layout };
})(window);
