// 难度实测台. This file *reads* the difficulty of each tier off generated boards — it does not set
// it. The numbers printed here are what `TIERS[].band` is supposed to contain, and the gate at the
// bottom goes red if a tier stops landing in its own band or if the medians stop ordering.
//
// Why a gate and not a table in a README: a band that nobody re-measures becomes decoration the first
// time someone edits a rule weight or a pruning pass, and the docs then assert something the code no
// longer does. Changing `Rules` in js/engine/tapa.js or the trimming here must move these numbers,
// and a move that is not re-read into TIERS is exactly what this exit code catches.
//
//   SAMPLES=24 npm run balance

import { performance } from 'node:perf_hooks';
import { TIERS, generate, randomInk } from '../js/engine/generate.js';
import { BLACK, WHITE, NO_CLUE, cluesFrom, clueFrom, solve, verify, complete, Rules } from '../js/engine/tapa.js';
import { analyze } from '../js/engine/count.js';
import { mix } from '../js/engine/rng.js';

const N = Number(process.env.SAMPLES || 24);
const q = (sorted, p) =>
  sorted.length ? sorted[Math.min(sorted.length - 1, Math.max(0, Math.round((sorted.length - 1) * p)))] : NaN;

// A band is a *selection target*, so the honest reading is "how many of a fresh sample of boards
// land in it", printed per tier rather than asserted per board: one unlucky board must not turn CI
// red, and a tier that has silently moved must.
const HIT_GATE = 0.75;

const countClues = (clue) => {
  let k = 0;
  for (const v of clue) if (v !== NO_CLUE) k++;
  return k;
};

const ladder = [];
const allRows = [];

for (let t = 0; t < TIERS.length; t++) {
  const tier = TIERS[t];
  const [w, h] = tier.size;
  const scores = [];
  const steps = [];
  const rounds = [];
  const elims = [];
  const clues = [];
  const zeros = [];
  const nishios = [];
  let accepted = 0;
  let inBand = 0;
  let ms = 0;
  let drawn = 0;
  let refused = 0;
  for (let s = 0; s < N; s++) {
    const t0 = performance.now();
    const g = generate(`balance|${t}|${s}`, t, { tries: 400 });
    ms += performance.now() - t0;
    if (!g) {
      refused++;
      continue;
    }
    accepted++;
    drawn += g.attempts;
    if (g.score >= tier.band[0] && g.score <= tier.band[1]) inBand++;
    scores.push(g.score);
    steps.push(g.steps);
    rounds.push(g.rounds);
    elims.push(g.elim);
    clues.push(g.clues);
    zeros.push(g.zeroClues);
    nishios.push(g.nishio);
  }
  const line = (label, arr, fmt = (v) => v) => {
    const a = arr.slice().sort((x, y) => x - y);
    console.log(`      ${label.padEnd(8)} p0 ${fmt(a[0])}  p25 ${fmt(q(a, 0.25))}  中位 ${fmt(q(a, 0.5))}  p75 ${fmt(q(a, 0.75))}  p90 ${fmt(q(a, 0.9))}  max ${fmt(a[a.length - 1])}`);
  };
  console.log(`\n${tier.name} ${tier.key} ${w}×${h}${tier.useNishio ? ' · 允许反证' : ' · 不用反证'} · band ${tier.band[0]}–${tier.band[1]}`);
  console.log(
    `      出题 ${accepted}/${N}（拒收 ${refused}），命中 band ${inBand}/${accepted} = ${(accepted ? (inBand / accepted) * 100 : 0).toFixed(0)}%，` +
      `平均每局抽 ${(drawn / Math.max(1, accepted)).toFixed(1)} 次答案，耗时 ${(ms / Math.max(1, N)).toFixed(1)} ms/局`
  );
  line('分数', scores, (v) => (v || 0).toFixed(1));
  line('推导步数', steps);
  line('传播轮数', rounds);
  line('排除份额', elims, (v) => (v || 0).toFixed(2));
  line('线索数', clues, (v) => `${v}/${w * h}`);
  line('0 0 0 条数', zeros);
  line('反证步数', nishios);
  const hitRate = accepted ? inBand / accepted : 1;
  if (hitRate < HIT_GATE) {
    console.log(`      ✗ 命中率 ${(hitRate * 100).toFixed(0)}% 低于门禁 ${(HIT_GATE * 100).toFixed(0)}%：band 与实测脱节`);
  }
  ladder.push({ tier, median: q(scores.slice().sort((x, y) => x - y), 0.5) || 0, hitRate, accepted, inBand });
  allRows.push({ tier, scores });
}

console.log('\n== 档位阶梯：中位分数必须严格递增，每档必须打进自己的 band ==');
let mono = true;
{
  let prev = -Infinity;
  for (const l of ladder) {
    const okScore = l.median > prev;
    const okHit = l.hitRate >= HIT_GATE;
    if (!okScore || !okHit) mono = false;
    console.log(
      `  ${okScore && okHit ? '✓' : '✗'} ${l.tier.name} ${l.tier.size.join('×')} 中位 ${l.median.toFixed(1)}` +
        `  band ${l.tier.band[0]}–${l.tier.band[1]}  命中 ${(l.hitRate * 100).toFixed(0)}%`
    );
    prev = l.median;
  }
  console.log(mono ? '  阶梯成立' : '  阶梯不成立：band 需要重测，或有一档偷偷变简单了');
}

// ---- the two promises, re-read on freshly generated boards --------------------
// 零猜测: the pencil path must finish every board this file ships a score for. Score is a reading of
// the derivation, so a board that cannot be derived has no business being measured at all.
console.log('\n== 零猜测：铅笔路径必须独立推完每一张被计入分数的盘 ==');
let derivable = 0;
let stalled = 0;
for (const { tier } of allRows) {
  for (let s = 0; s < 3; s++) {
    const g = generate(`derive|${tier.key}|${s}`, TIERS.indexOf(tier), { tries: 400 });
    if (!g) continue;
    const r = solve(g.board, { useNishio: tier.useNishio });
    if (r.ok && r.steps === g.board.n) derivable++;
    else {
      stalled++;
      console.log(`  ✗ ${tier.name} seed ${s}: ok=${r.ok} 步数=${r.steps}/${g.board.n} 未定=${r.undetermined} 矛盾=${r.conflict || '无'}`);
    }
  }
}
console.log(`  ${derivable}/${derivable + stalled} 张盘从空盘推到满盘，全程不回溯`);

// 唯一解, independently: the exhaustive counter shares no ring table and no rule with the solver, so
// "unique" is a second opinion rather than the same opinion twice. Large boards are capped by the
// walk's own node budget and reported as skipped, never as passing.
console.log('\n== 唯一解：穷举计数器独立复核（不共享规则表，也不共享环表）==');
let crossChecked = 0;
let crossBad = 0;
let crossSkipped = 0;
for (let t = 0; t < TIERS.length; t++) {
  for (let s = 0; s < 3; s++) {
    const g = generate(`cross|${t}|${s}`, t, { tries: 400 });
    if (!g) continue;
    const a = analyze(g.board, { limit: 2, maxNodes: 400000 });
    if (!a.exhaustive && a.code === 'many') {
      // The walk gave up having found a second colouring: that is a *failure* of the promise, not a
      // budget skip.
      crossBad++;
      console.log(`  ✗ ${TIERS[t].name} seed ${s}: 穷举找到第二个解（铅笔路径却说推得完）`);
      continue;
    }
    if (!a.exhaustive) {
      crossSkipped++;
      continue;
    }
    crossChecked++;
    if (a.code !== 'unique') {
      crossBad++;
      console.log(`  ✗ ${TIERS[t].name} seed ${s}: 穷举解数 ${a.count}（铅笔判定可推完）`);
      continue;
    }
    const mine = Array.from(solve(g.board, { useNishio: TIERS[t].useNishio }).derived).join(',');
    if (Array.from(a.solutions[0]).join(',') !== mine) {
      crossBad++;
      console.log(`  ✗ ${TIERS[t].name} seed ${s}: 两套实现给出的不是同一盘答案`);
    }
  }
}
console.log(`  ${crossChecked - crossBad}/${crossChecked} 局穷举复核与铅笔判定逐格一致${crossSkipped ? `，另有 ${crossSkipped} 局超预算未核` : ''}`);

// The answer the generator planted must be *the* answer the acceptance checks agree on. If it were
// not, every score above would be measuring a board nobody can actually win. Note this re-runs the
// whole factory (`generate`, retries and all) rather than one raw ink draw: a single unlucky draw is
// what the retry loop exists to reject, so testing it here would fail the sampler, not the promise.
console.log('\n== 出题器种下的答案，与验收器认的答案 ==');
{
  let total = 0;
  let broken = 0;
  const fail = (msg) => {
    broken++;
    if (broken <= 6) console.log(`  ✗ ${msg}`);
  };
  for (let s = 0; s < 60; s++) {
    const t = s % TIERS.length;
    const tier = TIERS[t];
    const [w, h] = tier.size;
    const g = generate(`plant|${t}|${s}`, t, { tries: 400 });
    if (!g) {
      total++;
      fail(`${tier.name} seed ${s}: 抽了 400 次仍没有一张既合法又可推的盘`);
      continue;
    }
    total++;
    const ink = Int8Array.from(g.solution);
    if (!ink.some((v) => v === BLACK)) fail(`${tier.name} seed ${s}: 种出了一张全白盘，没有任何黑格`);
    const bad = verify(g.board, ink);
    if (bad.length || !complete(g.board, ink)) {
      fail(`${tier.name} seed ${s}: 种下的答案没通过验收 ${bad.slice(0, 2).map((p) => p.why).join(' / ')}`);
    }
    // The trimmed-down set has to still derive, and derive to *that* answer: pruning may remove
    // clues, never a solution.
    const r = solve(g.board, { useNishio: tier.useNishio });
    if (!r.ok) fail(`${tier.name} seed ${s}: 剪完线索推不完了（未定 ${r.undetermined} 格）`);
    else if (!ink.every((v, i) => v === r.derived[i])) fail(`${tier.name} seed ${s}: 铅笔推出的不是种下的那一盘`);
    // Every clue left on the board is one the planted answer actually says — including the sentinel:
    // a stale `0` where the answer now reads `2 1` is exactly the kind of drift a shape check catches.
    const full = cluesFrom(w, h, ink);
    let drift = 0;
    for (let i = 0; i < w * h; i++) if (g.clue[i] !== NO_CLUE && g.clue[i] !== full[i]) drift++;
    if (drift) fail(`${tier.name} seed ${s}: 盘上有 ${drift} 条线索与种下的答案对不上`);
    // A trimmed board that carries more clues than the full set would mean the trimmer wrote clues.
    if (g.clues > countClues(full)) fail(`${tier.name} seed ${s}: 剪完反而多了线索`);
    if (tier.zero && g.zeroClues < 1) fail(`${tier.name} seed ${s}: 剪掉了最后一条 0 0 0`);
  }
  console.log(`  种解合法、剪后仍可推、且剪出来的线索逐条对得上：${total - broken}/${total}`);
  if (broken) mono = false;
}

// A score is only a difficulty reading if it is a property of the *board*. Re-running the solver on
// the same clue set must reproduce it exactly — otherwise TIERS[].band is measuring generator state.
console.log('\n== 复解一致（同一块盘重跑一次必须同分、同步数、同规则分布）==');
{
  let drift = 0;
  for (let t = 0; t < TIERS.length; t++) {
    const g = generate(`drift|${t}`, t, { tries: 400 });
    if (!g) continue;
    const again = solve(g.board, { useNishio: TIERS[t].useNishio });
    if (!again.ok || again.score !== g.score || again.steps !== g.steps || JSON.stringify(again.breakdown) !== JSON.stringify(g.breakdown)) {
      drift++;
      console.log(`  ✗ ${TIERS[t].name} 复解不一致`, again.ok, again.score, g.score, again.steps, g.steps);
    }
  }
  console.log(`  复解一致：${TIERS.length - drift}/${TIERS.length} 档`);
  if (drift) mono = false;
}

// The weights are what make the score mean something; if a rule stops firing on every tier the
// ladder is being carried by size alone, which is a different (and weaker) promise.
console.log('\n== 规则出场表（每档至少要有环上相容与二乘二禁/白格连通在场）==');
{
  let thin = 0;
  for (let t = 0; t < TIERS.length; t++) {
    const g = generate(`rules|${t}`, t, { tries: 400 });
    if (!g) continue;
    const b = g.breakdown;
    const need = [Rules.selfBlack.name, Rules.ring.name];
    const missing = need.filter((n) => !b[n]);
    const global = b[Rules.no2x2.name] || b[Rules.link.name] || 0;
    if (missing.length || !global) thin++;
    console.log(
      `  ${missing.length || !global ? '✗' : '✓'} ${TIERS[t].name} ` +
        need.concat([Rules.no2x2.name, Rules.link.name, Rules.nishio.name]).map((n) => `${n} ${b[n] || 0}`).join(' · ')
    );
  }
  if (thin) console.log('  有档位缺规则：分数就只剩盘大小在撑着');
}

// The `0 0 0` clue is the one a careless encoder loses, so every tier must still ship at least one.
console.log('\n== 每档都还带着 0 0 0 ==');
{
  let lost = 0;
  for (let t = 0; t < TIERS.length; t++) {
    let withZero = 0;
    for (let s = 0; s < 5; s++) {
      const g = generate(`zero|${t}|${s}`, t, { tries: 400 });
      if (g && g.zeroClues > 0) withZero++;
    }
    if (withZero < 5) lost++;
    console.log(`  ${withZero === 5 ? '✓' : '✗'} ${TIERS[t].name} 五局里 ${withZero} 局含 0 0 0`);
  }
  if (lost) mono = false;
}

// Sanity: a clue read off a planted answer must be the clue the answer implies, cell by cell. This is
// the generator's only geometry check that does not go through the solver.
console.log('\n== 种下的答案与盘上线索逐格自洽 ==');
{
  let cells_checked = 0;
  let wrong = 0;
  for (let s = 0; s < 40; s++) {
    const t = s % TIERS.length;
    const [w, h] = TIERS[t].size;
    const { cells } = randomInk(w, h, mix(700 + s), TIERS[t].fill);
    const clue = cluesFrom(w, h, cells);
    for (let i = 0; i < w * h; i++) {
      cells_checked++;
      const implied = clueFrom(w, h, cells, i);
      if (cells[i] === WHITE) {
        // a white cell may carry only `0 0 0` or nothing at all
        if (clue[i] !== 0 && clue[i] !== -1) wrong++;
        if (implied === 0 && clue[i] !== 0) wrong++;
      } else {
        if (clue[i] === 0) wrong++; // `0 0 0` on a black cell is the sentinel collision, again
        if (clue[i] !== -1 && clue[i] !== implied) wrong++;
      }
    }
  }
  console.log(`  ${cells_checked - wrong}/${cells_checked} 格的线索与答案自洽`);
  if (wrong) mono = false;
}

const ok2 = derivable + stalled > 0 && stalled === 0 && crossBad === 0 && mono;
console.log(`\n结论：${ok2 ? '阶梯与两条承诺都成立' : '有承诺不成立，见上文 ✗'}（exit ${ok2 ? 0 : 1}）`);
process.exit(ok2 ? 0 : 1);
