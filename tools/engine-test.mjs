// Engine unit tests, run in plain Node: `node tools/engine-test.mjs` (or `npm test`).
//
// The risk in this repo is not arithmetic but soundness. One rule that wrote a cell the clues do not
// force, and every board would still ship, the hints would still read plausibly, and "每一局都不用猜"
// would be a caption on a coin flip. So the expectations below are hand-derived from boards worked out
// on paper and written as literals — never read back off the solver. Where a wrong convention would
// silently agree with itself (an interior ring treated as a path, a clue of `0 0 0` treated as "no
// clue", a 2×2 judged while cells are still unknown), the test name says which convention is meant.

import {
  WHITE,
  BLACK,
  UNKNOWN,
  NO_CLUE,
  RING_ORDER,
  Rules,
  clueDigits,
  clueFrom,
  clueRuns,
  clueSum,
  cluesFrom,
  complete,
  createBoard,
  decodeClue,
  describeClue,
  encodeClue,
  isZeroClue,
  linkProblems,
  nextDeduction,
  nextValue,
  reachable,
  ringCells,
  ringLabel,
  ringPatterns,
  ringRuns,
  sameRuns,
  setCell,
  solve,
  createState,
  undo,
  verify,
} from '../js/engine/tapa.js';
import { analyze, listSolutions } from '../js/engine/count.js';

const OPEN = -1; // count.js spells "these solutions disagree" as -1; the engine spells it UNKNOWN

let pass = 0;
let fail = 0;
const eq = (name, got, want) => {
  if (String(got) === String(want)) pass++;
  else {
    fail++;
    console.log(`  FAIL ${name}\n       got  ${got}\n       want ${want}`);
  }
};
const ok = (name, cond, detail = '') => {
  if (cond) pass++;
  else {
    fail++;
    console.log(`  FAIL ${name} ${detail}`);
  }
};
const throws = (fn) => {
  try {
    fn();
    return '（没有抛错）';
  } catch (e) {
    return e.message;
  }
};
// A board described as text: '#' black, '.' white. Every clue is read off the picture.
const fromPicture = (rows) => {
  const h = rows.length;
  const w = rows[0].length;
  const cells = new Int8Array(w * h);
  for (let r = 0; r < h; r++) for (let c = 0; c < w; c++) cells[r * w + c] = rows[r][c] === '#' ? BLACK : WHITE;
  return { w, h, cells, clue: cluesFrom(w, h, cells) };
};
const picture = (w, cells) => {
  const out = [];
  for (let r = 0; r < cells.length / w; r++) out.push(Array.from(cells.slice(r * w, r * w + w), (v) => (v === BLACK ? '#' : '.')).join(''));
  return out.join('/');
};
// An ink sheet for the propagation tests: everything stays 未知 except the listed cells.
const inkOf = (board, { black = [], white = [] }) => {
  const st = createState(board);
  for (const i of white) setCell(st, i, WHITE);
  for (const i of black) setCell(st, i, BLACK);
  return st;
};

// ---------- 1. 线索是三个数字，而 0 是一个数字 -------------------------------

eq('3 补零成 3 0 0', encodeClue(3), 300);
eq('3 1 补成 3 1 0', encodeClue(3, 1), 310);
eq('0 0 0 编码为 0', encodeClue(0, 0, 0), 0);
eq('解码 310', JSON.stringify(decodeClue(310)), '[3,1,0]');
eq('解码 300', JSON.stringify(decodeClue(300)), '[3,0,0]');
eq('哨兵是 -1', NO_CLUE, -1);
eq('无线索解出 null', decodeClue(NO_CLUE), null);
eq('0 0 0 解出三个零', JSON.stringify(decodeClue(0)), '[0,0,0]');
eq('0 0 0 是线索', isZeroClue(0), true);
eq('无线索不是 0 0 0', isZeroClue(NO_CLUE), false);
eq('画面上 3 1 只有两个数字', JSON.stringify(clueDigits(310)), '[3,1]');
eq('画面上 0 0 0 有三个数字', JSON.stringify(clueDigits(0)), '[0,0,0]');
eq('画面上无线索一个数字也没有', JSON.stringify(clueDigits(NO_CLUE)), '[]');
eq('念出来：3 1', describeClue(310), '3 1');
eq('念出来：0 0 0', describeClue(0), '0 0 0');
eq('念出来：无线索', describeClue(NO_CLUE), '（无线索）');
eq('段长里没有零', JSON.stringify(clueRuns(310)), '[3,1]');
eq('0 0 0 一段也没有', JSON.stringify(clueRuns(0)), '[]');
eq('黑格总数', clueSum(320), 5);
eq('超出 0..8 的数字不开', throws(() => encodeClue(9)), '线索数字超出 0..8');
eq('负数不开', throws(() => encodeClue(-1)), '线索数字超出 0..8');
// If `0` doubled as the sentinel, a board of nine `0 0 0` clues would be "a board with no clues at
// all": it would refuse to open, and every 环上相容 step those clues carry would vanish.
{
  const allZero = Array.from({ length: 9 }, () => 0);
  eq('九个 0 0 0 的盘照样开盘', throws(() => createBoard(3, 3, allZero)), '（没有抛错）');
  const b = createBoard(3, 3, allZero);
  eq('开盘就认出九条线索', b.clues, 9);
  const s = solve(b);
  eq('全盘 0 0 0 推得完', s.ok, true);
  eq('推出来全是白格', picture(3, s.derived), '.../.../...');
  eq('一格黑也没有', s.derived.includes(BLACK), false);
  eq('第一条推导是那条 0 0 0 自己变白', s.rows[0].kind, 'self-white');
}

// ---------- 2. 环序与段：哪里接上、哪里不接上 --------------------------------

eq('环序顺时针从北起', RING_ORDER.map((r) => r[2]).join(''), '北东北东东南南西南西西北');
{
  const corner = ringCells(5, 5, 0);
  eq('角上只有三格', corner.length, 3);
  eq('角上环内容', JSON.stringify(Array.from(corner)), '[1,6,5]');
  eq('角上第一格在东', ringLabel(5, 5, 0, 0), '东');
  eq('角上最后一格在南', ringLabel(5, 5, 0, 2), '南');
  const edge = ringCells(5, 5, 2);
  eq('上边五格', edge.length, 5);
  eq('上边第一格在东', ringLabel(5, 5, 2, 0), '东');
  eq('上边最后一格在西', ringLabel(5, 5, 2, 4), '西');
  const mid = ringCells(5, 5, 12);
  eq('盘中八格', mid.length, 8);
  eq('盘中第一格在北', ringLabel(5, 5, 12, 0), '北');
  eq('盘中最后一格在西北', ringLabel(5, 5, 12, 7), '西北');
  eq('盘中环内容', JSON.stringify(Array.from(mid)), '[7,8,13,18,17,16,11,6]');
  eq('西北那一格是 (1,1)', Array.from(mid)[7], 6);
}
eq('角上三连黑读作 3', JSON.stringify(ringRuns(0b111, 3)), '[3]');
eq('角上两端黑读作 1 1（缺口在棋盘外，不接上）', JSON.stringify(ringRuns(0b101, 3)), '[1,1]');
eq('边上一排五格全黑读作 5', JSON.stringify(ringRuns(0b11111, 5)), '[5]');
eq('边上两端黑读作 1 1（首尾不相接）', JSON.stringify(ringRuns(0b10001, 5)), '[1,1]');
eq('边上隔两格读作 1 1 1', JSON.stringify(ringRuns(0b10101, 5)), '[1,1,1]');
eq('北与西北相邻，读作一段 2', JSON.stringify(ringRuns(0b10000001, 8)), '[2]');
eq('北、东南、南三段独立', JSON.stringify(ringRuns(0b00011100, 8)), '[3]');
eq('环上全黑读作 8（不是 1 自己加回去）', JSON.stringify(ringRuns(0xff, 8)), '[8]');
eq('隔格全黑读作 1 1 1 1', JSON.stringify(ringRuns(0b10101010, 8)), '[1,1,1,1]');
eq('北到东南四连黑读作 4', JSON.stringify(ringRuns(0b00001111, 8)), '[4]');
eq('绕头相连的 1 2 1 读作 4', JSON.stringify(ringRuns(0b10000111, 8)), '[4]');
eq('空环一段也没有', JSON.stringify(ringRuns(0, 8)), '[]');
{
  // The same two facts in the numbers a player would see.
  //  ##.        (0,0)'s ring is the three cells (0,1), (1,1), (1,0): the two black ones sit at the
  //  ...        *ends* of that path with the middle white. A cycle would merge them into `2`.
  const c = new Int8Array(9);
  c[1] = BLACK;
  c[3] = BLACK;
  eq('角格两端黑写 1 1', describeClue(clueFrom(3, 3, c, 0)), '1 1');
  c[4] = BLACK;
  eq('角格三连黑写 3', describeClue(clueFrom(3, 3, c, 0)), '3');
  //  ##.        Now those same two cells are 北 and 西北 of the interior cell (1,1), whose ring is a
  //  ...        genuine cycle: one run of two, not `1 1`.
  const d = new Int8Array(9);
  d[0] = BLACK;
  d[1] = BLACK;
  eq('中心格北与西北两黑写 2', describeClue(clueFrom(3, 3, d, 4)), '2');
  eq('中心格那一段不是 1 1', clueFrom(3, 3, d, 4), encodeClue(2));
}
eq('段序列按环序逐位比', sameRuns([2, 1], [2, 1]), true);
eq('顺序反过来就不是同一条线索', sameRuns([2, 1], [1, 2]), false);
eq('段序列长度不同不等价', sameRuns([2, 1], [1, 1]), false);
eq('空段只等于空', sameRuns([], []), true);
eq('空段不等于一段', sameRuns([], [1]), false);
{
  // The clue's order is load-bearing, so it gets its own board rather than a unit on the comparator.
  // Same 5×5, same interior clue cell 第3行第3列, three black neighbours each — but read from north
  // one of them says `2 1` and the other says `1 2`. Slot order is 北东北东东南南西南西西北, so
  // 北+东北+西南 is (1,1,0,0,0,1,0,0) = 35 and 北+南+西南 is (1,0,0,0,1,1,0,0) = 49.
  const a = new Int8Array(25);
  for (const i of [12, 7, 8, 16]) a[i] = BLACK;
  const b = new Int8Array(25);
  for (const i of [12, 7, 17, 16]) b[i] = BLACK;
  const ca = clueFrom(5, 5, a, 12);
  const cb = clueFrom(5, 5, b, 12);
  eq('先遇到两格那段就写 2 1', describeClue(ca), '2 1');
  eq('同一格里换个摆法就写 1 2', describeClue(cb), '1 2');
  eq('2 1 认得北东北加西南', ringPatterns(ca, 8).includes(35), true);
  eq('2 1 不认得北南西南', ringPatterns(ca, 8).includes(49), false);
  eq('1 2 认得北南加西南', ringPatterns(cb, 8).includes(49), true);
  eq('1 2 不认得北东北加西南', ringPatterns(cb, 8).includes(35), false);
  eq('两条线索的摆法合起来才覆盖全部三黑', ringPatterns(ca, 8).some((m) => ringPatterns(cb, 8).includes(m)), false);
}

// ---------- 3. 环上摆法的枚举：数量由两条独立算式撑着 -------------------------
//
// Hand-counting eight-slot rings is exactly the kind of arithmetic that reads convincingly and is
// wrong (two drafts of this file got `2 1` wrong, once by a factor of two). So every count below
// comes from one of two derivations that do not share a mistake:
//
//   * Path rings — a corner's 3 slots, an edge's 5 — are counted by stars and bars: m runs with R
//     black cells in s slots need s-R white cells, m-1 of which are pinned between the runs, and the
//     rest are free to sit in any of the m+1 gaps, which is C(s-R+1, m).
//   * Cycle rings are checked by partition: each of the 2^8 colourings reads as exactly one run list,
//     and the only colourings no three-number clue can name are the four-run ones — on an eight-cycle
//     that is 0b01010101 and 0b10101010, both with four black cells. So for each k the pattern sets of
//     all clues summing to k must cover exactly C(8,k) colourings, minus those two when k is 4.
//
// Both routes are computed here rather than written as literals, and the literals that *are* written
// down each carry their one-line justification next to them.

const binom = (n, k) => {
  if (k < 0 || k > n) return 0;
  let v = 1;
  for (let i = 1; i <= k; i++) v = (v * (n - k + i)) / i;
  return v;
};
const pcount = (runs, s) => ringPatterns(encodeClue(runs[0] || 0, runs[1] || 0, runs[2] || 0), s).length;
// Every clue a three-number cell can carry with `parts` groups, positive and in ring order.
const compositions = (s, parts) => {
  if (parts === 1) return s >= 1 ? [[s]] : [];
  const out = [];
  for (let first = 1; first <= s; first++) for (const rest of compositions(s - first, parts - 1)) out.push([first, ...rest]);
  return out;
};
const allRuns = (s) => {
  const out = [[]];
  for (let total = 1; total <= s; total++) for (let parts = 1; parts <= 3; parts++) for (const c of compositions(total, parts)) out.push(c);
  return out;
};
// A second, deliberately different reading of "in ring order, clockwise from north": find the arc that
// *contains* north by walking one step each way from slot 0, write its length first, then scan the
// rest of the ring left to right. The engine reaches the same list with an accumulate-and-merge loop;
// bucketing all 256 colourings with this function is what lets the counts below be evidence rather
// than the engine quoting itself.
const readRing = (bits) => {
  const n = bits.length;
  const scan = (from, to) => {
    const out = [];
    let cur = 0;
    for (let s = from; s < to; s++) {
      if (bits[s]) cur++;
      else if (cur) {
        out.push(cur);
        cur = 0;
      }
    }
    if (cur) out.push(cur);
    return out;
  };
  if (n !== 8) return scan(0, n);
  if (!bits[0]) return scan(1, n); // north white ⇒ the cycle is cut, slots 1..7 are a path
  let back = 0;
  while (bits[7 - back]) back++;
  let fwd = 0;
  while (fwd < n && bits[fwd]) fwd++;
  if (fwd === n) return [n]; // the whole ring black: one arc of eight
  return [back + fwd, ...scan(fwd, n - back)];
};
const bitsOf = (mask, slots) => Array.from({ length: slots }, (_, s) => (mask >> s) & 1);
const oracleCount = (runs, slots) => {
  let k = 0;
  for (let mask = 0; mask < 1 << slots; mask++) if (String(readRing(bitsOf(mask, slots))) === String(runs)) k++;
  return k;
};
for (const slots of [3, 5, 8]) {
  let bad = 0;
  for (const runs of allRuns(slots)) {
    const got = ringPatterns(encodeClue(runs[0] || 0, runs[1] || 0, runs[2] || 0), slots);
    if (String(got) !== String([...Array(1 << slots).keys()].filter((m) => String(readRing(bitsOf(m, slots))) === String(runs)))) bad++;
  }
  eq(`${slots} 格环上每一条线索的摆法都与独立读法逐位相同`, bad, 0);
}


eq('角上写 3 一种摆法', pcount([3], 3), 1);
eq('角上写 1 三种摆法', pcount([1], 3), 3);
eq('角上写 2 两种摆法', pcount([2], 3), 2);
eq('角上写 1 1 一种（两端）', pcount([1, 1], 3), 1);
eq('边上五格写 3 三种', pcount([3], 5), 3);
eq('边上五格写 4 两种', pcount([4], 5), 2);
eq('边上五格写 2 四种', pcount([2], 5), 4);
eq('边上五格写 1 1 六种', pcount([1, 1], 5), 6);
eq('边上五格写 2 2 一种', pcount([2, 2], 5), 1);
for (const s of [3, 5]) {
  let union = 0;
  for (const runs of allRuns(s)) {
    const got = pcount(runs, s);
    const want = binom(s - runs.reduce((a, b) => a + b, 0) + 1, runs.length);
    eq(`路径环 ${s} 格写 ${runs.join(' ') || '0 0 0'} 等于 C(${s - runs.reduce((a, b) => a + b, 0) + 1},${runs.length})`, got, want);
    union += got;
  }
  eq(`${s} 格的路径环被三类线索分完`, union, 1 << s);
}
{
  // The cycle, one row of the partition at a time: summing the pattern counts over every clue whose
  // three numbers add up to k must land on C(8,k) — the two unnameable four-run colourings are the
  // only thing subtracted, and they are both four-black.
  const rows = [];
  for (let k = 0; k <= 8; k++) {
    // k = 0 is the `0 0 0` clue, which is not a composition of anything into groups — it is the one
    // clue whose run list is empty, and the only name for the all-white ring.
    let sum = k === 0 ? pcount([], 8) : 0;
    for (let parts = 1; parts <= 3; parts++) {
      for (const runs of compositions(k, parts)) sum += pcount(runs, 8);
    }
    const want = binom(8, k) - (k === 4 ? 2 : 0);
    rows.push(`${k}:${sum}/${want}`);
    eq(`八格环上 ${k} 个黑格的摆法分完`, sum, want);
  }
  eq('分位表不留余数（八行全对）', rows.every((r) => r.split('/')[0].split(':')[1] === r.split('/')[1]), true);
}
eq('环上八格写 8 一种（全黑）', pcount([8], 8), 1);
eq('环上八格写 1 八种（黑格在哪个方位都行）', pcount([1], 8), 8);
eq('环上八格写 7 八种（白格在哪个方位都行）', pcount([7], 8), 8);
eq('环上八格写 4 八种（四连黑有八个起点）', pcount([4], 8), 8);
eq('环上八格写 1 1 二十种（C(8,2) 减掉相邻的 8 对）', pcount([1, 1], 8), 20);
eq('环上八格写 1 1 二十种（C(8,2) 减掉相邻的 8 对）', pcount([1, 1], 8), 20);
eq('环上八格写 2 2 十二种（骨牌 8 处 × 隔开的 3 处 ÷ 2）', pcount([2, 2], 8), 12);
eq('环上八格写 1 1 1 十六种（环形三子不邻：8×6÷3）', pcount([1, 1, 1], 8), 16);
// Asymmetric clues cannot be counted without deciding where north is, which IS the point of the
// order: the arc straddling north is written first. What is countable on paper is the pair — a domino
// (8 places) and a lone black that touches neither end (4 places) is 32 colourings, each read either
// `2 1` or `1 2`, and the split is 18/9+... not even. So the split comes from `readRing` above and
// only the total is asserted here.
eq('2 1 与 1 2 合起来正好是全部两段三环', pcount([2, 1], 8) + pcount([1, 2], 8), 32);
eq('2 1 与 1 2 各占一半是错的（跨北的那段先写）', pcount([2, 1], 8) === pcount([1, 2], 8), false);
eq('3 1 与 1 3 合起来是三连黑加一格孤黑', pcount([3, 1], 8) + pcount([1, 3], 8), 24);
eq('四黑三段三种读法分完剩下的一行', pcount([2, 1, 1], 8) + pcount([1, 2, 1], 8) + pcount([1, 1, 2], 8), 24);
eq('四黑一整行分完 68', pcount([4], 8) + pcount([2, 2], 8) + pcount([3, 1], 8) + pcount([1, 3], 8) + pcount([2, 1, 1], 8) + pcount([1, 2, 1], 8) + pcount([1, 1, 2], 8), 68);

eq('0 0 0 只有全白一种', JSON.stringify(ringPatterns(0, 8)), '[0]');
eq('0 0 0 在角上也是全白一种', JSON.stringify(ringPatterns(0, 3)), '[0]');
eq('无线索不枚举', ringPatterns(NO_CLUE, 8), null);
eq('四段黑格三位数字说不出来', ringPatterns(encodeClue(1, 1, 1), 8).includes(0b10101010), false);
eq('摆法两两不同', new Set(ringPatterns(encodeClue(2, 1), 8)).size, pcount([2, 1], 8));
eq('摆法里黑格数都对得上', ringPatterns(encodeClue(2, 1), 8).every((m) => m.toString(2).split('1').length - 1 === 3), true);
{
  // Three groups do not fit in a corner: the engine's job is to hand back an empty list, and the
  // solver's job is to read that as "this board is wrong now", not as "nothing to do".
  eq('角上写 1 1 1 一种摆法也没有', pcount([1, 1, 1], 3), 0);
  const b = createBoard(3, 3, Array.from({ length: 9 }, (_, i) => (i === 0 ? encodeClue(1, 1, 1) : NO_CLUE)));
  eq('这种盘照样能开盘（长度没超环长）', b.clues, 1);
  const s = solve(b);
  eq('开盘后第一步就把矛盾报出来', s.ok, false);
  eq('矛盾点在那条说不出来的线索上', /1 1 1/.test(s.conflict || ''), true);
}


// ---------- 4. 从一幅图读出整盘线索 -----------------------------------------

{
  const p = fromPicture(['.#...', '.##..', '....#', '..##.', '#....']);
  eq('第 1 行第 2 列写 2', describeClue(p.clue[1]), '2');
  eq('第 2 行第 2 列写 1 1', describeClue(p.clue[6]), '1 1');
  eq('第 2 行第 3 列写 2', describeClue(p.clue[7]), '2');
  eq('第 3 行第 5 列写 1', describeClue(p.clue[14]), '1');
  eq('第 4 行第 3 列写 1', describeClue(p.clue[17]), '1');
  eq('第 4 行第 4 列写 1 1', describeClue(p.clue[18]), '1 1');
  eq('右上角是 0 0 0', describeClue(p.clue[4]), '0 0 0');
  eq('孤立左下角黑格带不走线索', p.clue[20], NO_CLUE);
  eq('白格不写非零线索', p.clue[0], NO_CLUE);
  eq('白格环上明明是 2 2 也不给它线索', `${describeClue(clueFrom(5, 5, p.cells, 12))}/${p.clue[12]}`, '2 2/-1');
  const full = createBoard(5, 5, Array.from(p.clue));
  eq('整盘七条线索', full.clues, 7);
  eq('其中一条 0 0 0', full.zeroClues, 1);
  eq('摆法总数 4+20+8+5+8+20+1', full.patternTotal, 66);
  // Four runs around a cell needs four digits, which a Tapa clue does not have.
  const q = new Int8Array(9);
  for (const i of [0, 2, 6, 8]) q[i] = BLACK;
  eq('四段黑格写不出来', clueFrom(3, 3, q, 4), null);
  eq('四段黑格那一格留空', cluesFrom(3, 3, q)[4], NO_CLUE);
}
eq('环长不够时直接拒绝', throws(() => createBoard(3, 3, Array.from({ length: 9 }, (_, i) => (i === 0 ? encodeClue(8) : NO_CLUE)))), '第1行1列 写着 8，需要 8 个黑格，可它环上只有 3 格');
eq('同样八个黑格的要求写在角上就开不了', throws(() => createBoard(3, 3, Array.from({ length: 9 }, (_, i) => (i === 4 ? encodeClue(9) : NO_CLUE)))), '线索数字超出 0..8');
eq('角上写 3 反而合法', createBoard(3, 3, Array.from({ length: 9 }, (_, i) => (i === 0 ? encodeClue(3) : NO_CLUE))).clues, 1);
eq('尺寸不对不开盘', throws(() => createBoard(2, 2, Array.from({ length: 4 }, () => 0))), '盘至少 3×3');
eq('线索长度不对不开盘', throws(() => createBoard(3, 3, Array.from({ length: 8 }, () => 0))), 'clue length mismatch');
eq('一条线索也没有不开盘', throws(() => createBoard(3, 3, Array.from({ length: 9 }, () => NO_CLUE))), '盘上没有线索');

// ---------- 5. 每条规则各自能写出什么 ---------------------------------------

{
  // 线索自黑. Note the centre carries no clue at all — a white cell cannot be handed `8` — so what
  // makes it white is a corner's `1 1`, which is exactly what the ring enumeration is for.
  const p = fromPicture(['###', '#.#', '###']);
  const b = createBoard(3, 3, Array.from(p.clue));
  const s = solve(b);
  eq('八条线索一圈黑', b.clues, 8);
  eq('中心自己不带线索', describeClue(b.clue[4]), '（无线索）');
  eq('角上写 1 1', describeClue(b.clue[0]), '1 1');
  eq('边上写 2 2', describeClue(b.clue[1]), '2 2');
  eq('外圈八格都自己变黑', [0, 1, 2, 3, 5, 6, 7, 8].every((i) => s.derived[i] === BLACK), true);
  eq('中心被角上的 1 1 逼成白格', s.derived[4], WHITE);
  eq('这一盘推得完', s.ok, true);
  eq('推出来的就是原图', picture(3, s.derived), '###/#.#/###');
  eq('自黑记八步', s.breakdown[Rules.selfBlack.name], 8);
}
{
  // One clue `1` in the middle of a 4×4: its own cell is decided, its ring is not, and nothing else
  // on the board has an opinion. The pencil path must stop there instead of picking a winner.
  const b = createBoard(4, 4, Array.from({ length: 16 }, (_, i) => (i === 5 ? encodeClue(1) : NO_CLUE)));
  const s = solve(b);
  eq('带线索的格自己黑了', s.derived[5], BLACK);
  eq('八种摆法谁都定不下来', s.ok, false);
  eq('剩下十五格没定', s.undetermined, 15);
  eq('环上相容一步也没有', s.breakdown[Rules.ring.name] || 0, 0);
  eq('没有矛盾可报', s.conflict, null);
  eq('反证也不凭空决定（确实不止一解）', s.nishio, 0);
}
{
  // 二乘二禁: three of a 2×2 already black ⇒ the fourth is white. Everything the other rules could
  // say is pre-written into the ink, so this test isolates the one write being observed.
  const b = createBoard(4, 4, Array.from({ length: 16 }, (_, i) => (i === 0 ? 0 : NO_CLUE)));
  const st = inkOf(b, { black: [9, 10, 13], white: [0, 1, 4, 5] });
  const step = nextDeduction(b, st.cell);
  eq('下一步是二乘二禁', step.rule.name, Rules.no2x2.name);
  eq('写成白格', step.value, WHITE);
  eq('落点是第 4 行第 3 列', step.cell, 14);
  eq('说法点出已有三格黑', /三格是黑|已有三格/.test(step.why), true);
  const four = inkOf(b, { black: [9, 10, 13, 14], white: [0, 1, 4, 5] });
  eq('四格全黑立刻被指认', verify(b, four.cell).some((p) => p.kind === 'block'), true);
  eq('四格全黑时也拒绝继续推', /2×2/.test(nextDeduction(b, four.cell).conflict), true);
  // A 2×2 with unknowns in it is *not* a violation — three blacks and an open corner is a position a
  // real solution passes through, and an engine that threw here would reject its own generator.
  const three = inkOf(b, { black: [9, 10, 13], white: [0, 1, 4, 5] });
  eq('三黑一未知不算违规', verify(b, three.cell).length, 0);
}
{
  // 白格连通·口袋: a `0 0 0` whites the middle nine of a 5×5; with the twelve cells around them black
  // the four corners touch no white at all, so no white can ever live there — the pocket goes black.
  const b = createBoard(5, 5, Array.from({ length: 25 }, (_, i) => (i === 12 ? 0 : NO_CLUE)));
  const wall = [1, 2, 3, 5, 9, 10, 14, 15, 19, 21, 22, 23];
  const st = inkOf(b, { black: wall, white: [6, 7, 8, 11, 12, 13, 16, 17, 18] });
  const step = nextDeduction(b, st.cell);
  eq('下一步是白格连通', step.rule.name, Rules.link.name);
  eq('类型是口袋', step.kind, 'pocket');
  eq('先写左上角', step.cell, 0);
  eq('写成黑格', step.value, BLACK);
  eq('说法点出连成一整块', /连成/.test(step.why), true);
  const after = inkOf(b, { black: wall.concat([0, 4, 20, 24]), white: [6, 7, 8, 11, 12, 13, 16, 17, 18] });
  eq('四角塞进黑格后就是一整块白', verify(b, after.cell).length, 0);
  eq('那一盘也是可解的', reachable(b, after.cell), true);
  // One clue on a 5×5 is not a puzzle: the pencil path whites the middle nine and then has to stop,
  // because nothing on the board says anything about the outer ring. "推得完" is a property of the
  // clue set, never of a rule, and a generator that forgot this would ship boards nobody can finish.
  const alone = solve(b);
  eq('单一条线索推不完这一盘', alone.ok, false);
  eq('推不完也没瞎猜：外圈还剩十六格', alone.undetermined, 16);
  eq('中间九格确实被 0 0 0 写白了', [6, 7, 8, 11, 12, 13, 16, 17, 18].every((i) => alone.derived[i] === WHITE), true);
}
{
  // 白格连通·割点: 5 wide, 3 tall. A `0 0 0` in the top-left whites four cells; column 2 is black at
  // (0,2) and (2,2), so the left block and the right block meet only through cell 7 — it can never go
  // black without cutting the whites in two.
  const b = createBoard(5, 3, Array.from({ length: 15 }, (_, i) => (i === 0 ? 0 : NO_CLUE)));
  const st = inkOf(b, { black: [2, 12], white: [0, 1, 5, 6, 8] });
  const step = nextDeduction(b, st.cell);
  eq('下一步是白格连通（割点）', step.rule.name, Rules.link.name);
  eq('类型是割点', step.kind, 'cut');
  eq('落点是唯一的那座桥', step.cell, 7);
  eq('写成白格', step.value, WHITE);
  eq('说法点出切成两半', /切成两半/.test(step.why), true);
  const cut = inkOf(b, { black: [2, 7, 12], white: [0, 1, 5, 6, 8] });
  eq('把桥斩断就报白格分裂', linkProblems(b, cut.cell).length > 0, true);
  eq('分裂的盘不可解', reachable(b, cut.cell), false);
}
{
  // verify() must be able to blame a finished board on more than one count at once, so a green sheet
  // can never mean "nothing was checked".
  const b = createBoard(3, 3, Array.from({ length: 9 }, () => 0));
  const bad = new Int8Array(9).fill(BLACK);
  const v = verify(b, bad);
  eq('全黑的盘被指认为违规', v.length > 0, true);
  eq('违规里点到线索格该是白格', v.some((p) => p.kind === 'clue' && /白格/.test(p.why)), true);
  eq('违规里点到 2×2', v.some((p) => p.kind === 'block'), true);
  eq('九个九宫格全被点到', v.filter((p) => p.kind === 'block').length, 4);
  eq('全黑盘不是解', complete(b, bad), false);
  eq('全白盘是解', complete(b, new Int8Array(9).fill(WHITE)), true);
  eq('未知格既不表扬也不指责', verify(b, new Int8Array(9).fill(UNKNOWN)).length, 0);
  // A board with no white cells at all is not a *connectivity* violation — "所有白格连成一块" is
  // vacuously true — so the complaint has to come from the 2×2 count and nowhere else. Asserting
  // that here keeps a future linkPass from inventing a rule the rules text does not have.
  eq('全黑盘没有被扣上分裂的帽子', v.some((p) => p.kind === 'link'), false);
}
{
  // Three ways a finished sheet reads wrong, each blamed on its own count. The picture is the 5×5
  // sample, so the clues are non-zero and a misplaced black changes what a ring *reads* rather than
  // only how much black it holds.
  const p = fromPicture(['.#...', '.##..', '....#', '..##.', '#....']);
  const b = createBoard(5, 5, Array.from(p.clue));
  const cell1 = new Int8Array(25); // cell 6 carries `1 1`: two blacks that touch is the wrong shape
  cell1[0] = BLACK;
  cell1[1] = BLACK;
  cell1[6] = BLACK;
  for (const i of b.clued) if (i !== 6 && i !== 0 && i !== 1) cell1[i] = WHITE;
  eq('环上读出的段不对也会被指出', verify(b, cell1).some((x) => /实际是/.test(x.why)), true);
  const tooMuch = Int8Array.from(cell1);
  tooMuch[7] = BLACK;
  eq('环上黑多了会被指出', verify(b, tooMuch).some((x) => /已经有/.test(x.why)), true);
  const paintedWhite = new Int8Array(25);
  eq('带线索的格写成白会被指出', verify(b, paintedWhite).some((x) => /必须是黑格/.test(x.why)), true);
  eq('一格也没落子时不算违规', verify(b, new Int8Array(25).fill(UNKNOWN)).length, 0);
}

// ---------- 6. 落子与撤回：一次手势一步 -------------------------------------

{
  const b = createBoard(3, 3, Array.from({ length: 9 }, () => 0));
  const st = createState(b);
  eq('初始全是未知', st.cell[0], UNKNOWN);
  eq('未知点一下变黑', nextValue(UNKNOWN), BLACK);
  eq('黑点一下变白', nextValue(BLACK), WHITE);
  eq('白点一下回未知', nextValue(WHITE), UNKNOWN);
  eq('三格循环回自己', nextValue(nextValue(nextValue(WHITE))), WHITE);
  eq('第一次落子成功', setCell(st, 4, BLACK), true);
  eq('重复落同一格不算一步', setCell(st, 4, BLACK), false);
  eq('落子记了一步历史', st.history.length, 1);
  eq('撤回回到未知', undo(st), true);
  eq('撤回后确实是未知', st.cell[4], UNKNOWN);
  eq('没有历史时撤回失败', undo(st), false);
  eq('越界落子失败', setCell(st, 99, BLACK), false);
}

// ---------- 7. 两套互不信任的实现必须逐格一致 -------------------------------

// The claim, in the direction that can actually be tested: whatever the pencil path writes, the
// exhaustive walk cannot escape; and a board the pencil path finishes is called unique by that walk.
// The converse is deliberately NOT claimed — an ambiguous board is refused by the solver, not
// "solved" by the walker, and a board the walker cannot afford to finish proves nothing either way.
const crossBoards = [
  ['全盘 0 0 0 的 3×3', createBoard(3, 3, Array.from({ length: 9 }, () => 0))],
  ['环心写 1 的 4×4', createBoard(4, 4, Array.from({ length: 16 }, (_, i) => (i === 5 ? encodeClue(1) : NO_CLUE)))],
  ['样图整盘线索', createBoard(5, 5, Array.from(fromPicture(['.#...', '.##..', '....#', '..##.', '#....']).clue))],
  ['单条 0 0 0 的 4×4', createBoard(4, 4, Array.from({ length: 16 }, (_, i) => (i === 0 ? 0 : NO_CLUE)))],
  ['一圈黑中心白', createBoard(3, 3, Array.from(fromPicture(['###', '#.#', '###']).clue))],
  ['中心 0 0 0 外加一圈墙', createBoard(5, 5, Array.from({ length: 25 }, (_, i) => (i === 12 ? 0 : NO_CLUE)))],
];
for (const [label, board] of crossBoards) {
  const s = solve(board);
  const a = analyze(board, { limit: 6, maxNodes: 400000 });
  // Sound in both directions, and it holds whether or not the walk finished: every colouring the
  // exhaustive counter produced is a real solution, so a cell the pencil wrote had better show that
  // colour in at least one of them.
  const disagreed = [];
  for (let i = 0; i < board.n; i++) {
    if (s.derived[i] === UNKNOWN) continue;
    if (a.solutions.length && a.solutions.every((sol) => sol[i] !== s.derived[i])) disagreed.push(i);
  }
  eq(`${label}：铅笔写的每一格都有穷举解支持`, disagreed.length, 0);
  if (a.exhaustive) {
    let mismatch = 0;
    for (let i = 0; i < board.n; i++) {
      if (s.derived[i] === UNKNOWN) continue;
      if (a.forced[i] !== s.derived[i]) mismatch++;
    }
    eq(`${label}：走穷之后铅笔写的每格都是穷举也点名的必然格`, mismatch, 0);
    if (s.ok) {
      eq(`${label}：推得完 ⇒ 穷举唯一`, a.code, 'unique');
      eq(`${label}：推出来的答案自己合法`, verify(board, s.derived).length, 0);
      eq(`${label}：和穷举的那一个解逐格相同`, picture(board.w, a.solutions[0]), picture(board.w, s.derived));
    } else {
      ok(`${label}：推不完时要么真有分歧要么有矛盾`, a.code !== 'unique' || !!s.conflict, `${a.code} / ${s.conflict}`);
    }
  } else {
    ok(`${label}：穷举提前收工（${a.code}，${a.count} 个解，${a.nodes} 个节点）`, a.code === 'many' && !s.ok, `${a.code} / ok=${s.ok}`);
  }
}
{
  const b = createBoard(4, 4, Array.from({ length: 16 }, (_, i) => (i === 5 ? encodeClue(1) : NO_CLUE)));
  const a = analyze(b, { limit: 8, maxNodes: 300000 });
  eq('环心写 1 的盘不止一解', a.code, 'many');
  eq('停在第八个解上就没走穷', a.exhaustive, false);
  eq('没走穷就不宣布任何一格是必然的', a.forced.every((v) => v === OPEN), true);
  eq('黑格数带不回精确值', String(a.count), '8+');
  eq('找到的每种解里带线索那格都黑', a.solutions.every((s) => s[5] === BLACK), true);
  eq('找到的每种解都通过校验', a.solutions.every((s) => verify(b, s).length === 0), true);
  eq('列得出两份解', listSolutions(b, 2, { maxNodes: 300000 }).length, 2);
  // 3 格环上写 1 1 1 摆不出来，而穷举走完全部 512 种染色后必须敢报"无解"——报不出这一条的计数器
  // 也报不出唯一解。
  const dry = analyze(createBoard(3, 3, Array.from({ length: 9 }, (_, i) => (i === 0 ? encodeClue(1, 1, 1) : NO_CLUE))));
  eq('摆不出来的盘报无解', dry.code, 'none');
  eq('无解是走穷了得出的', dry.exhaustive, true);
  eq('一个解也没有', dry.count, 0);
}
{
  // reachable(): one wrong black breaks no visible count, so the engine has to be the one to notice.
  // The hand-made sheet below is a *finished legal answer* to a board carrying a single `0 0 0`:
  // the clue's own cell and its whole ring white, the whites in one piece, and — the part that is
  // easy to miss — no 2×2 all black anywhere else on the board either.
  const b = createBoard(4, 4, Array.from({ length: 16 }, (_, i) => (i === 0 ? 0 : NO_CLUE)));
  const good = new Int8Array(16).fill(BLACK);
  for (const i of [0, 1, 4, 5, 7, 9, 10, 11, 14, 15]) good[i] = WHITE; // ..##/..#./#.../##..
  eq('自己造的合法盘是可解的', reachable(b, good), true);
  eq('合法盘通得过校验', verify(b, good).length, 0);
  eq('合法盘确实是一个完整解', complete(b, good), true);
  // The tempting four-cell answer — white the clue and its ring, black everything else — satisfies
  // the clue and keeps the whites in one piece, and it is still not a board: it leaves five 2×2
  // black blocks behind. Asserting *why* it is refused is the point of this block; a fixture that
  // quietly broke rule 3 would pass the three lines above for the wrong reason.
  const naive = new Int8Array(16).fill(BLACK);
  for (const i of [0, 1, 4, 5]) naive[i] = WHITE;
  eq('只染白 0 0 0 那一圈留下的盘被 2×2 指认五处', verify(b, naive).filter((p) => p.kind === 'block').length, 5);
  eq('那张非法盘也确实不可解', reachable(b, naive), false);
  const sealed = Int8Array.from(good);
  sealed[12] = WHITE; // 第4行1列的上下右（8、13）都已经是黑格，这一袋白永远出不去
  eq('被黑格围死的白袋不算可解', reachable(b, sealed), false);
  const wrongRing = Int8Array.from(good);
  for (const i of [1, 4, 5]) wrongRing[i] = BLACK;
  eq('把 0 0 0 的环改黑就不可解', reachable(b, wrongRing), false);
  eq('改黑的环被点名为环上黑多了', verify(b, wrongRing).some((p) => p.kind === 'clue' && /已经有/.test(p.why)), true);
  // The same move read the other way round: on a bare sheet, whiteing the clue's own cell and its
  // ring is exactly what `0 0 0` asks for, so the engine must never object to it. A `false` here
  // would refuse the generator's first step on every board that carries a `0 0 0`.
  const wrongClue = new Int8Array(16).fill(UNKNOWN);
  for (const i of [0, 1, 4, 5]) wrongClue[i] = WHITE;
  eq('把 0 0 0 的环改白仍然可解', reachable(b, wrongClue), true);
  eq('空盘上添这一圈白还不算违规', verify(b, wrongClue).length, 0);
  // And a legal sheet stays legal when more cells go white, as long as no 2×2 is left all black:
  // cells 2 and 6 are black in `good` and whitening both is a move a player is allowed to survive.
  const wider = Int8Array.from(good);
  wider[2] = WHITE;
  wider[6] = WHITE;
  eq('再多改两格白仍然是合法盘', reachable(b, wider), true);
  eq('再多改两格白也通得过校验', verify(b, wider).length, 0);
}
{
  // The two implementations were written from the same prose with different code, so an agreement
  // here is evidence and not a tautology: this is the case where the merge matters.
  const c = new Int8Array(9);
  c[0] = BLACK;
  c[1] = BLACK;
  const b = createBoard(3, 3, Array.from(cluesFrom(3, 3, c)));
  const a = analyze(b, { limit: 2, maxNodes: 300000 });
  eq('北与西北连成一段的那种线索，穷举也认', a.code, 'unique');
  eq('唯一解就是那两格黑', picture(3, a.solutions[0]), '##./.../...');
  eq('铅笔也推得完这一盘', solve(b).ok, true);
}

console.log(`\n${pass} 条断言通过 / ${fail} 条失败`);
process.exit(fail ? 1 : 0);
