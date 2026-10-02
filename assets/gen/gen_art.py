#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""视窗 / Tapa 的美术资产生成器 —— 纯 python3 标准库,无 Pillow、无字体、无 rsvg。

为什么手写栅格器:图标与贴图是这个仓唯一"看得见"的部分,而一条换台机器就跑不通的生成
路线等于没有生成路线。这里所有图形都是符号距离场(SDF),逐像素解算,1px 线性过渡白送抗
锯齿;PNG 用 struct + zlib 自己编码。任何一台有 python3 的机器上
`python3 assets/gen/gen_art.py` 都能字节级复现同一套图(无时间戳、无按机而变的字体)。

视觉母题(依据 = js/theme.js 的 Palette 令牌 + 玩法本身:线索格自己必黑,八邻环顺时针数段):
  地    三段暗坡渐变 #070A14 → #121829 → #18203A,与 css/game.css 里 body 的 gradient 同形
  墨格  一枚亮 #F2F5FB 的圆角方块 —— 本游戏把"黑格"画成墨色,写着数字那格按规则必黑
  环    #6FD3C5 的 dashed hoop,就是 `0 0 0` 那句实打实的证词(和"这里没数字"是两回事)
  线索  罗盘位(北/东/西)上的深色小牌 + 金色 #FFC85C 数字,顺时针读段长
  字    自带一套单线大写笔画字与数字骨架,折线定义在 0..1 × 0..1.4 的字盒里,任何尺寸都算得出

用法: python3 assets/gen/gen_art.py [--only icon-1024.png,og-1200x630.png] [--verify]
"""
import argparse
import hashlib
import math
import os
import struct
import sys
import zlib

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HERE, "..", ".."))
OUTDIR = os.path.join(REPO, "assets", "img")

# ------------------------------------------------------------------ 令牌(theme.js 的对账对象)
INK = (0x07, 0x0A, 0x14)      # Palette.bgTop
BASIN = (0x12, 0x18, 0x29)    # Palette.bgBottom
PLATE = (0x0F, 0x14, 0x24)    # Palette.surface
LIFT = (0x18, 0x20, 0x3A)     # Palette.surfaceLift
LINE = (0x22, 0x2D, 0x4C)     # Palette.line
RIM = (0x3A, 0x4A, 0x72)      # Palette.lineHeavy
PAPER = (0xF2, 0xF5, 0xFB)    # Palette.ink —— "黑格"在本游戏里的画法
GOLD = (0xFF, 0xC8, 0x5C)     # Palette.accent
GOLD_HI = (0xFF, 0xE3, 0xA6)  # Palette.accentEdge
TEAL = (0x6F, 0xD3, 0xC5)     # Palette.zeroClue
BLUE = (0x7B, 0xB8, 0xFF)     # Palette.hint
GREEN = (0x3D, 0xDC, 0x91)    # Palette.success

TOKEN_MAP = {"bgTop": INK, "bgBottom": BASIN, "surface": PLATE, "surfaceLift": LIFT, "line": LINE,
             "lineHeavy": RIM, "ink": PAPER, "accent": GOLD, "accentEdge": GOLD_HI,
             "zeroClue": TEAL, "hint": BLUE, "success": GREEN}


def check_tokens():
    """令牌漂了就报:美术和代码用两套色,是这个仓最容易烂掉的一致性。"""
    import re
    try:
        src = open(os.path.join(REPO, "js", "theme.js"), encoding="utf-8").read()
    except OSError:
        return []
    got = dict(re.findall(
        r"^\s*(bgTop|bgBottom|surface|surfaceLift|line|lineHeavy|ink|accent|accentEdge|"
        r"zeroClue|hint|success):\s*'#([0-9A-Fa-f]{6})'", src, re.M))
    drift = []
    for name, rgb in TOKEN_MAP.items():
        hexv = got.get(name)
        if hexv is None:
            continue
        want = (int(hexv[0:2], 16), int(hexv[2:4], 16), int(hexv[4:6], 16))
        if want != rgb:
            drift.append("%s 美术#%02X%02X%02X!=theme.js#%s" % (name, rgb[0], rgb[1], rgb[2], hexv))
    return drift


# ------------------------------------------------------------------ 距离场基元
# 一个 shape = (color, fn, bbox);color 是 (r,g,b) 或 (r,g,b,a);fn(px,py) 返回带符号距离,
# 单位是"设计单位"。bbox 只做像素循环的粗筛,不参与成像。
def rbox(hx_, hy_, rad, ox=0.0, oy=0.0):
    def fn(px, py):
        qx = abs(px - ox) - hx_ + rad
        qy = abs(py - oy) - hy_ + rad
        ax = qx if qx > 0.0 else 0.0
        ay = qy if qy > 0.0 else 0.0
        inside = (qx if qx > qy else qy)
        if inside > 0.0:
            inside = 0.0
        return math.hypot(ax, ay) + inside - rad
    return fn


def disc(r, ox=0.0, oy=0.0):
    return lambda px, py: math.hypot(px - ox, py - oy) - r


def annulus(r, w, ox=0.0, oy=0.0):
    half = w * 0.5
    return lambda px, py: abs(math.hypot(px - ox, py - oy) - r) - half


def dashed_ring(r, w, ox, oy, dashes, duty=0.58, phase=0.0):
    """`0 0 0` 的那圈虚线:径向 annulus 与角向方波取 max(交集)。

    角向距离必须乘回半径换成弧长 —— 弧度减弧度、再和设计单位里的径向距离取 max,
    数值上永远够不到抗锯齿阈值,画出来就是一圈没有缝的实环。
    """
    half = w * 0.5
    seg = 2.0 * math.pi / dashes
    gate = seg * duty * 0.5

    def fn(px, py):
        dx = px - ox
        dy = py - oy
        radial = abs(math.hypot(dx, dy) - r) - half
        a = math.atan2(dy, dx) + phase
        t = (a + math.pi) % seg - seg * 0.5
        ang = (abs(t) - gate) * r
        return max(radial, ang)
    return fn


def capsule_chain(pts, r):
    """折线(圆头):各段 capsule 取 min,一次成型 ⇒ 接缝不会二次混色。"""
    segs = list(zip(pts, pts[1:]))
    if not segs:
        x0, y0 = pts[0]
        return disc(r, x0, y0)

    def fn(px, py):
        best = 1e18
        for (ax, ay), (bx, by) in segs:
            abx = bx - ax
            aby = by - ay
            dd = abx * abx + aby * aby
            t = 0.0 if dd == 0.0 else ((px - ax) * abx + (py - ay) * aby) / dd
            if t < 0.0:
                t = 0.0
            elif t > 1.0:
                t = 1.0
            qx = px - (ax + abx * t)
            qy = py - (ay + aby * t)
            v = qx * qx + qy * qy
            if v < best:
                best = v
        return math.sqrt(best) - r
    return fn


def frame(hx_, hy_, w, rad):
    outer = rbox(hx_, hy_, rad)
    inner = rbox(hx_ - w, hy_ - w, max(0.0, rad - w))
    return lambda px, py: max(outer(px, py), -inner(px, py))


def intersect(a, b):
    return lambda px, py: max(a(px, py), b(px, py))


def union_fns(fns):
    def fn(px, py):
        best = 1e18
        for f in fns:
            v = f(px, py)
            if v < best:
                best = v
        return best
    return fn


def shape(color, fn, bbox):
    return (color, fn, bbox)


def box(x0, y0, x1, y1):
    return (x0, y0, x1, y1)


def pts_box(pts, pad):
    xs = [p[0] for p in pts]
    ys = [p[1] for p in pts]
    return box(min(xs) - pad, min(ys) - pad, max(xs) + pad, max(ys) + pad)


def tshape(sh, dx, dy, sc):
    """把 shape 缩放再平移:world = local*sc + (dx,dy)。"""
    color, fn, (x0, y0, x1, y1) = sh
    inner = fn

    def out(px, py):
        return inner((px - dx) / sc, (py - dy) / sc) * sc
    return (color, out, box(x0 * sc + dx, y0 * sc + dy, x1 * sc + dx, y1 * sc + dy))


def tint(color, alpha):
    return (color[0], color[1], color[2], alpha)


# ------------------------------------------------------------------ 笔画字
GLYPHS = {
    "0": [[(.30, .06), (.70, .06), (.90, .30), (.90, 1.10), (.70, 1.36), (.30, 1.36),
           (.10, 1.10), (.10, .30), (.30, .06)]],
    "1": [[(.5, .08), (.5, 1.12)], [(.22, .34), (.5, .08)], [(.24, 1.12), (.76, 1.12)]],
    "2": [[(.16, .30), (.50, .08), (.84, .34)], [(.84, .34), (.84, .58)],
          [(.84, .58), (.16, 1.12)], [(.16, 1.12), (.84, 1.12)]],
    "3": [[(.16, .14), (.84, .30)], [(.84, .30), (.50, .58)], [(.50, .58), (.84, .80)],
          [(.84, .80), (.50, 1.10)], [(.50, 1.10), (.16, .92)]],
    "4": [[(.72, .08), (.16, .74)], [(.16, .74), (.88, .74)], [(.72, .08), (.72, 1.12)]],
    "5": [[(.84, .08), (.24, .08)], [(.24, .08), (.20, .52)], [(.20, .52), (.62, .46)],
          [(.62, .46), (.86, .70)], [(.86, .70), (.58, 1.10)], [(.58, 1.10), (.18, .96)]],
    "6": [[(.78, .10), (.34, .34)], [(.34, .34), (.18, .84)], [(.18, .84), (.50, 1.12)],
          [(.50, 1.12), (.82, .90)], [(.82, .90), (.60, .58)], [(.60, .58), (.24, .66)]],
    "7": [[(.16, .10), (.86, .10)], [(.86, .10), (.42, 1.12)]],
    "8": [[(.50, .08), (.22, .30)], [(.22, .30), (.50, .56)], [(.50, .56), (.78, .30)],
          [(.78, .30), (.50, .08)], [(.50, .56), (.20, .82)], [(.20, .82), (.50, 1.12)],
          [(.50, 1.12), (.80, .82)], [(.80, .82), (.50, .56)]],
    "9": [[(.22, .10), (.66, .34)], [(.66, .34), (.82, .84)], [(.82, .84), (.50, 1.12)],
          [(.50, 1.12), (.18, .90)], [(.18, .90), (.40, .58)], [(.40, .58), (.76, .66)]],
    "A": [[(.06, 1.40), (.50, .00)], [(.50, .00), (.94, 1.40)], [(.20, .92), (.80, .92)]],
    "B": [[(.18, .04), (.18, 1.36)], [(.18, .04), (.66, .04)], [(.66, .04), (.84, .22)],
          [(.84, .22), (.84, .50)], [(.84, .50), (.66, .68)], [(.66, .68), (.18, .68)],
          [(.18, .68), (.70, .68)], [(.70, .68), (.88, .88)], [(.88, .88), (.88, 1.16)],
          [(.88, 1.16), (.70, 1.36)], [(.70, 1.36), (.18, 1.36)]],
    "C": [[(.90, .26), (.50, .02)], [(.50, .02), (.12, .30)], [(.12, .30), (.12, 1.10)],
          [(.12, 1.10), (.50, 1.38)], [(.50, 1.38), (.90, 1.14)]],
    "D": [[(.16, .04), (.16, 1.36)], [(.16, .04), (.58, .04)], [(.58, .04), (.88, .34)],
          [(.88, .34), (.88, 1.06)], [(.88, 1.06), (.58, 1.36)], [(.58, 1.36), (.16, 1.36)]],
    "E": [[(.88, .04), (.12, .04)], [(.12, .04), (.12, 1.36)], [(.12, 1.36), (.88, 1.36)],
          [(.12, .70), (.72, .70)]],
    "G": [[(.90, .26), (.50, .02)], [(.50, .02), (.12, .30)], [(.12, .30), (.12, 1.10)],
          [(.12, 1.10), (.50, 1.38)], [(.50, 1.38), (.90, 1.14)], [(.90, 1.14), (.90, .78)],
          [(.90, .78), (.56, .78)]],
    "H": [[(.14, .04), (.14, 1.36)], [(.86, .04), (.86, 1.36)], [(.14, .70), (.86, .70)]],
    "I": [[(.50, .04), (.50, 1.36)], [(.22, .04), (.78, .04)], [(.22, 1.36), (.78, 1.36)]],
    "K": [[(.16, .04), (.16, 1.36)], [(.86, .04), (.16, .72)], [(.40, .50), (.88, 1.36)]],
    "L": [[(.16, .04), (.16, 1.36)], [(.16, 1.36), (.88, 1.36)]],
    "M": [[(.08, 1.38), (.08, .04)], [(.08, .04), (.50, .86)], [(.50, .86), (.92, .04)],
          [(.92, .04), (.92, 1.38)]],
    "N": [[(.14, .04), (.14, 1.36)], [(.14, .04), (.86, 1.36)], [(.86, .04), (.86, 1.36)]],
    "O": [[(.50, .02), (.14, .30)], [(.14, .30), (.14, 1.10)], [(.14, 1.10), (.50, 1.38)],
          [(.50, 1.38), (.86, 1.10)], [(.86, 1.10), (.86, .30)], [(.86, .30), (.50, .02)]],
    "P": [[(.18, 1.40), (.18, .04)], [(.18, .04), (.70, .04)], [(.70, .04), (.88, .30)],
          [(.88, .30), (.70, .60)], [(.70, .60), (.18, .60)]],
    "R": [[(.18, 1.40), (.18, .04)], [(.18, .04), (.70, .04)], [(.70, .04), (.88, .30)],
          [(.88, .30), (.70, .60)], [(.70, .60), (.18, .60)], [(.46, .60), (.88, 1.40)]],
    "S": [[(.88, .24), (.50, .02)], [(.50, .02), (.14, .26)], [(.14, .26), (.50, .70)],
          [(.50, .70), (.86, .96)], [(.86, .96), (.50, 1.38)], [(.50, 1.38), (.12, 1.16)]],
    "T": [[(.08, .06), (.92, .06)], [(.50, .06), (.50, 1.40)]],
    "U": [[(.14, .04), (.14, 1.06)], [(.14, 1.06), (.50, 1.38)], [(.50, 1.38), (.86, 1.06)],
          [(.86, 1.06), (.86, .04)]],
    "V": [[(.08, .04), (.50, 1.38)], [(.92, .04), (.50, 1.38)]],
    "W": [[(.04, .04), (.26, 1.40)], [(.26, 1.40), (.50, .50)], [(.50, .50), (.74, 1.40)],
          [(.74, 1.40), (.96, .04)]],
    "X": [[(.12, .04), (.88, 1.36)], [(.88, .04), (.12, 1.36)]],
    "Y": [[(.10, .04), (.50, .72)], [(.90, .04), (.50, .72)], [(.50, .72), (.50, 1.40)]],
    "Z": [[(.12, .06), (.88, .06)], [(.88, .06), (.12, 1.36)], [(.12, 1.36), (.88, 1.36)]],
    "·": [[(.50, .74), (.50, .74)]],
    "-": [[(.14, .70), (.86, .70)]],
    "/": [[(.86, .04), (.14, 1.36)]],
    " ": [],
}


def glyph_scale(cap):
    return cap / 1.4


def text_width(s, cap, stroke, track=0.30):
    return len(s) * (0.94 * glyph_scale(cap) + track * stroke)


def text_shapes(s, x, y, cap, stroke, color, track=0.30):
    """字盒**左上角** (x,y) —— 设计空间里 v 向上,所以笔画的 py 要往负 v 走,否则整行字上下翻。

    缺字直接报错而不是静默少一根线:静默丢笔会让图标"看着像但有根线没了"。
    """
    out = []
    sc = glyph_scale(cap)
    adv = 0.94 * sc + track * stroke
    pen = x
    for ch in s:
        if ch not in GLYPHS:
            raise SystemExit("笔画字表缺 '%s' —— 补进 GLYPHS,不许静默丢字" % ch)
        for poly in GLYPHS[ch]:
            pts = [(pen + px * sc, y - py * sc) for px, py in poly]
            out.append(shape(color, capsule_chain(pts, stroke * 0.5), pts_box(pts, stroke)))
        pen += adv
    return out


# ------------------------------------------------------------------ 画布
class Painter(object):
    """w×h 像素。设计坐标 (u,v) 以画布中心为原点、v 向上为正;unit = 设计单位/像素。"""

    def __init__(self, w, h, unit):
        self.w, self.h, self.unit = w, h, unit
        n = w * h
        self.r = [0.0] * n
        self.g = [0.0] * n
        self.b = [0.0] * n
        self.a = [0.0] * n

    def bg_gradient(self, top, bottom, surface, split=0.62):
        """与 css/game.css 里 body 的 linear-gradient(180deg, top 0%, bottom 62%, surface 100%) 同形。"""
        w, h = self.w, self.h
        t0 = [c / 255.0 for c in top]
        t1 = [c / 255.0 for c in bottom]
        t2 = [c / 255.0 for c in surface]
        for y in range(h):
            t = (y + 0.5) / h
            if t <= split:
                f = t / split
                col = [t0[i] * (1 - f) + t1[i] * f for i in range(3)]
            else:
                f = (t - split) / (1 - split)
                col = [t1[i] * (1 - f) + t2[i] * f for i in range(3)]
            off = y * w
            for x in range(w):
                i = off + x
                self.r[i] = col[0]
                self.g[i] = col[1]
                self.b[i] = col[2]
                self.a[i] = 1.0

    def add(self, sh):
        color, dist, bx = sh
        if len(color) == 4:
            mul = color[3] / 255.0
            color = color[:3]
        else:
            mul = 1.0
        cr, cg, cb = color[0] / 255.0, color[1] / 255.0, color[2] / 255.0
        w, h, unit = self.w, self.h, self.unit
        cxp, cyp = w * 0.5, h * 0.5
        x0, y0, x1, y1 = bx
        sx0 = int(math.floor(x0 / unit + cxp)) - 1
        sx1 = int(math.ceil(x1 / unit + cxp)) + 1
        sy0 = int(math.floor(cyp - y1 / unit)) - 1
        sy1 = int(math.ceil(cyp - y0 / unit)) + 1
        sx0 = 0 if sx0 < 0 else sx0
        sy0 = 0 if sy0 < 0 else sy0
        sx1 = w if sx1 > w else sx1
        sy1 = h if sy1 > h else sy1
        aa = unit
        inv = 1.0 / (2.0 * aa)
        R, G, B, A = self.r, self.g, self.b, self.a
        for y in range(sy0, sy1):
            py = cyp - (y + 0.5)
            row = y * w
            for x in range(sx0, sx1):
                d = dist((x + 0.5 - cxp) * unit, py * unit)
                if d >= aa:
                    continue
                c = 1.0 if d <= -aa else (aa - d) * inv
                if mul < 1.0:
                    c *= mul
                i = row + x
                al = A[i]
                # r/g/b 存的是 premultiplied 值:over 就是按覆盖率向源色插值
                R[i] += c * (cr - R[i])
                G[i] += c * (cg - G[i])
                B[i] += c * (cb - B[i])
                A[i] = al + c * (1.0 - al)

    def apply_mask(self, fn, outside_alpha=0.0):
        """把整幅按 fn 的覆盖率乘进 alpha —— 圆角卡片就是一次掩膜,而不是把每个形状裁一遍。"""
        w, h, unit = self.w, self.h, self.unit
        cxp, cyp = w * 0.5, h * 0.5
        aa = unit
        inv = 1.0 / (2.0 * aa)
        R, G, B, A = self.r, self.g, self.b, self.a
        for y in range(h):
            py = (cyp - (y + 0.5)) * unit
            row = y * w
            for x in range(w):
                d = fn((x + 0.5 - cxp) * unit, py)
                c = 1.0 if d <= -aa else (0.0 if d >= aa else (aa - d) * inv)
                if c >= 1.0:
                    continue
                i = row + x
                A[i] *= c
                R[i] *= c
                G[i] *= c
                B[i] *= c

    def to_rgba(self):
        w, h = self.w, self.h
        out = bytearray(w * h * 4)
        R, G, B, A = self.r, self.g, self.b, self.a
        for i in range(w * h):
            a = A[i]
            if a <= 0.0:
                continue
            o = i * 4
            inv = 1.0 / a
            out[o] = max(0, min(255, int(R[i] * inv * 255.0 + 0.5)))
            out[o + 1] = max(0, min(255, int(G[i] * inv * 255.0 + 0.5)))
            out[o + 2] = max(0, min(255, int(B[i] * inv * 255.0 + 0.5)))
            out[o + 3] = max(0, min(255, int(a * 255.0 + 0.5)))
        return out


def encode_png(w, h, rgba):
    stride = w * 4
    raw = bytearray(h * (stride + 1))
    pos = 0
    for y in range(h):
        raw[pos] = 0  # filter None:逐行不过滤,最短且可复现
        pos += 1
        s = y * stride
        raw[pos:pos + stride] = rgba[s:s + stride]
        pos += stride

    def chunk(tag, data):
        return (struct.pack(">I", len(data)) + tag + data
                + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF))
    return (b"\x89PNG\r\n\x1a\n"
            + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 6, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(bytes(raw), 9))
            + chunk(b"IEND", b""))


# ------------------------------------------------------------------ 母题:一枚带八邻环证词的线索格
MOTIF_HALF = 256.0  # 设计空间 [-256,256]²


def motif(detail="hi"):
    """返回 shape 列表(不含背景,背景由调用方的渐变 + apply_mask 负责)。

    detail:hi  = 网格 + 墨格 + 虚线环 + 三枚罗盘位数字牌(≥96px)
           mid = 去掉细网格,数字牌保留(48~96px)
           lo  = 只留墨格 + 虚线环,墨格放大(≤32px —— 那个尺寸上细节就是噪声)
    """
    H = MOTIF_HALF
    sp = []
    if detail == "hi":
        gl = []
        for g in (-36.0, 36.0):
            gl.append(capsule_chain([(-118.0, g), (118.0, g)], 2.6))
            gl.append(capsule_chain([(g, -118.0), (g, 118.0)], 2.6))
        sp.append(shape(LINE, union_fns(gl), box(-120, -120, 120, 120)))
    cell = 58.0 if detail == "lo" else 52.0
    sp.append(shape(PAPER, rbox(cell, cell, 14.0), box(-cell - 2, -cell - 2, cell + 2, cell + 2)))
    ring_r = 88.0 if detail == "lo" else 78.0
    ring_w = 22.0 if detail == "lo" else (7.5 if detail == "hi" else 9.0)
    nd = 8 if detail == "lo" else 12
    sp.append(shape(TEAL, dashed_ring(ring_r, ring_w, 0.0, 0.0, nd),
                    box(-ring_r - 8, -ring_r - 8, ring_r + 8, ring_r + 8)))
    if detail in ("hi", "mid"):
        # 罗盘位:数字从正北起顺时针读,所以北在 +v(画面顶上),不是 -v
        for dx, dy, digit in ((0.0, 108.0, "2"), (108.0, 0.0, "1"), (-108.0, 0.0, "3")):
            b = 30.0
            bb = box(dx - b - 2, dy - b - 2, dx + b + 2, dy + b + 2)
            sp.append(shape(INK, rbox(b, b, 9.0), bb))
            sp.append(shape(RIM, frame(b, b, 2.4, 9.0), bb))
            cap, sw = 40.0, 6.6
            tw = text_width(digit, cap, sw)
            sp.extend(text_shapes(digit, dx - tw * 0.5, dy + cap * 0.5, cap, sw, GOLD))
    return sp


def render_icon(size, maskable=False):
    """方形应用图标:满幅渐变地 + 母题 + 圆角掩膜(maskable 则满幅不裁 + 母题收进安全区)。"""
    detail = "hi" if size >= 96 else ("mid" if size >= 48 else "lo")
    unit = 512.0 / size
    p = Painter(size, size, unit)
    p.bg_gradient(INK, BASIN, PLATE, 0.58)
    sc = 0.80 if maskable else 1.22
    for sh in motif(detail):
        p.add(tshape(sh, 0.0, 0.0, sc))
    if not maskable:
        rad = 0.225 * MOTIF_HALF * 2.0
        p.apply_mask(rbox(MOTIF_HALF - 1, MOTIF_HALF - 1, rad))
        p.add(shape(RIM, frame(MOTIF_HALF - 2.5, MOTIF_HALF - 2.5, 3.0, rad),
                    box(-MOTIF_HALF, -MOTIF_HALF, MOTIF_HALF, MOTIF_HALF)))
    return encode_png(size, size, p.to_rgba())


# ------------------------------------------------------------------ 社交卡 1200×630
def render_og(w=1200, h=630):
    """社交卡:左母题 + 右字标。设计单位 = 像素,原点卡在正中,v 向上。"""
    p = Painter(w, h, 1.0)
    p.bg_gradient(INK, BASIN, PLATE, 0.58)
    place = 230.0
    sc = place / MOTIF_HALF
    for sh in motif("hi"):
        p.add(tshape(sh, -w * 0.5 + place + 46.0, 0.0, sc))
    p.apply_mask(rbox(w * 0.5 - 1, h * 0.5 - 1, 30.0))
    p.add(shape(RIM, frame(w * 0.5 - 2, h * 0.5 - 2, 3.0, 29.0), box(-w, -h, w, h)))

    tx = -w * 0.5 + 2 * place + 104
    top = 172.0  # 字标顶边;往下排

    cap = 112.0
    p_group(text_shapes("TAPA", tx, top, cap, 13.0, GOLD, track=0.55), p)
    y = top - cap - 30.0
    cap2 = 34.0
    p_group(text_shapes("ZERO GUESS LOGIC", tx, y, cap2, 4.6, PAPER, track=0.5), p)
    y -= cap2 + 22.0
    p_group(text_shapes("EIGHT RING CLUES", tx, y, cap2, 4.6, TEAL, track=0.5), p)
    y -= cap2 + 34.0
    p.add(shape(RIM, capsule_chain([(tx, y), (tx + 596.0, y)], 1.6),
                box(tx - 4, y - 4, tx + 600, y + 4)))

    # 规则一句:写着数字那格自己必黑 —— 拿三枚罗盘位数字当图例
    cy = y - 52.0
    cx = tx
    for dg, col in (("2", GOLD), ("1", GOLD), ("0", TEAL)):
        b = 23.0
        bb = box(cx - b - 2, cy - b - 2, cx + b + 2, cy + b + 2)
        p.add(shape(INK, rbox(b, b, 7.0), bb))
        p.add(shape(TEAL if dg == "0" else RIM, frame(b, b, 1.8, 7.0), bb))
        cw = text_width(dg, 26.0, 4.4)
        p_group(text_shapes(dg, cx - cw * 0.5, cy + 13.0, 26.0, 4.4, col), p)
        cx += 2 * b + 22.0
    p_group(text_shapes("CLUE CELL IS BLACK", cx + 14, cy + 11.0, 22.0, 3.4,
                        tint(PAPER, 235), track=0.45), p)
    p_group(text_shapes("ONE SOLUTION  EVERY STEP DERIVABLE", tx, -212.0, 22.0, 3.4,
                        tint(RIM, 250), track=0.45), p)
    return encode_png(w, h, p.to_rgba())


def p_group(shapes, painter):
    for s in shapes:
        painter.add(s)


# ------------------------------------------------------------------ 棋纹与墨点精灵
def render_grain(size=256, seed=20261002):
    """棋盘纸纹:低频云 + 织纹 + 点位。坐标全部按 size 取模,所以左右上下严格无缝平铺。"""
    w = h = size

    def hash2(ix, iy, per):
        x = ix % per
        y = iy % per
        z = (x * 374761393 + y * 668265263) & 0xFFFFFFFF
        z = ((z ^ (z >> 13)) * 1274126177) & 0xFFFFFFFF
        return ((z ^ (z >> 16)) & 0xFFFF) / 65535.0

    def vnoise(u, v, per):
        fx = u * per
        fy = v * per
        ix = int(math.floor(fx))
        iy = int(math.floor(fy))
        tx = fx - ix
        ty = fy - iy
        sx = tx * tx * (3.0 - 2.0 * tx)
        sy = ty * ty * (3.0 - 2.0 * ty)
        a = hash2(ix, iy, per)
        b = hash2(ix + 1, iy, per)
        c = hash2(ix, iy + 1, per)
        d = hash2(ix + 1, iy + 1, per)
        return (a * (1 - sx) + b * sx) * (1 - sy) + (c * (1 - sx) + d * sx) * sy

    n = w * h
    R = [0.0] * n
    G = [0.0] * n
    B = [0.0] * n
    grid = 32
    for y in range(h):
        v = y / h
        row = y * w
        for x in range(w):
            u = x / w
            cloud = vnoise(u, v, 4) * 0.6 + vnoise(u, v, 8) * 0.25 + vnoise(u, v, 16) * 0.15
            dot = 1 if (x % 16 == 0 and y % 16 == 0) else 0
            weave = 1 if ((x + y) % grid == 0 or (x - y) % grid == 0) else 0
            lum = (cloud - 0.5) * 0.050 + 0.010 * weave + 0.034 * dot
            base = LIFT if dot else PLATE
            i = row + x
            R[i] = max(0.0, min(1.0, base[0] / 255.0 + lum))
            G[i] = max(0.0, min(1.0, base[1] / 255.0 + lum))
            B[i] = max(0.0, min(1.0, base[2] / 255.0 + lum))
    out = bytearray(n * 4)
    for i in range(n):
        o = i * 4
        out[o] = int(R[i] * 255.0 + 0.5)
        out[o + 1] = int(G[i] * 255.0 + 0.5)
        out[o + 2] = int(B[i] * 255.0 + 0.5)
        out[o + 3] = 255
    return encode_png(w, h, out)


def render_ink_sprite(size=128):
    """落墨/胜利粒子的精灵:金色墨核 + 软衰减外圈 + 一点冷芯,近看不糊成一团黄。"""
    w = h = size
    n = w * h
    out = bytearray(n * 4)
    for y in range(h):
        vy = 1.0 - (y + 0.5) * 2.0 / h
        row = y * w
        for x in range(w):
            vx = (x + 0.5) * 2.0 / w - 1.0
            d = math.hypot(vx, vy)
            if d >= 1.0:
                continue
            core = 1.0 if d < 0.34 else (0.0 if d > 0.46 else (0.46 - d) / 0.12)
            halo = (1.0 - d) ** 3 * 0.5
            al = min(1.0, core + halo)
            if al <= 0.002:
                continue
            f = (core * GOLD_HI[0] + halo * GOLD[0]) / 255.0
            g = (core * GOLD_HI[1] + halo * GOLD[1]) / 255.0
            b = (core * GOLD_HI[2] + halo * GOLD[2]) / 255.0
            if d < 0.16:
                k = (0.16 - d) / 0.16 * 0.7
                f += k * (BLUE[0] / 255.0 - f)
                g += k * (BLUE[1] / 255.0 - g)
                b += k * (BLUE[2] / 255.0 - b)
            o = (row + x) * 4
            out[o] = max(0, min(255, int(f * 255.0 + 0.5)))
            out[o + 1] = max(0, min(255, int(g * 255.0 + 0.5)))
            out[o + 2] = max(0, min(255, int(b * 255.0 + 0.5)))
            out[o + 3] = max(0, min(255, int(al * 255.0 + 0.5)))
    return encode_png(w, h, out)


def render_pulse_sprite(size=64):
    """提示脉冲环的贴图:一圈青蓝渐隐的 hoop,和 canvas 上 pulse 的语义同形。"""
    w = h = size
    out = bytearray(w * h * 4)
    for y in range(h):
        vy = 1.0 - (y + 0.5) * 2.0 / h
        for x in range(w):
            vx = (x + 0.5) * 2.0 / w - 1.0
            d = math.hypot(vx, vy)
            band = abs(d - 0.72) - 0.10
            if band >= 0.0:
                continue
            al = min(1.0, (0.0 - band) / 0.10)
            o = (y * w + x) * 4
            out[o] = BLUE[0]
            out[o + 1] = BLUE[1]
            out[o + 2] = BLUE[2]
            out[o + 3] = int(al * 210 + 0.5)
    return encode_png(w, h, out)


# ------------------------------------------------------------------ 产物
def products():
    return [
        ("icon-1024.png", lambda: render_icon(1024)),
        ("icon-512.png", lambda: render_icon(512)),
        ("icon-192.png", lambda: render_icon(192)),
        ("icon-180.png", lambda: render_icon(180, maskable=True)),
        ("icon-96.png", lambda: render_icon(96)),
        ("icon-32.png", lambda: render_icon(32)),
        ("icon-16.png", lambda: render_icon(16)),
        ("icon-maskable-512.png", lambda: render_icon(512, maskable=True)),
        ("apple-touch-icon.png", lambda: render_icon(180)),
        ("favicon-32.png", lambda: render_icon(32)),
        ("favicon-16.png", lambda: render_icon(16)),
        ("og-1200x630.png", lambda: render_og()),
        ("board-grain.png", lambda: render_grain(256)),
        ("ink-sprite.png", lambda: render_ink_sprite(128)),
        ("pulse-hoop.png", lambda: render_pulse_sprite(64)),
    ]


def main():
    ap = argparse.ArgumentParser(description="生成 视窗/Tapa 的美术资产(纯标准库)")
    ap.add_argument("--only", default=None, help="逗号分隔的产物文件名")
    ap.add_argument("--verify", action="store_true", help="重栅格化并比对盘上 sha256,不写文件")
    a = ap.parse_args()

    for line in check_tokens():
        print("WARN 令牌漂移: " + line, file=sys.stderr)

    want = set(x.strip() for x in a.only.split(",")) if a.only else None
    os.makedirs(OUTDIR, exist_ok=True)
    bad = []
    for name, fn in products():
        if want and name not in want:
            continue
        data = fn()
        path = os.path.join(OUTDIR, name)
        sha = hashlib.sha256(data).hexdigest()[:16]
        if a.verify:
            if not os.path.exists(path):
                print("MISSING %s" % name)
                bad.append(name)
                continue
            disk = hashlib.sha256(open(path, "rb").read()).hexdigest()[:16]
            print("%-26s %s %s" % (name, "SAME" if disk == sha else "DIFF", sha))
            if disk != sha:
                bad.append(name)
        else:
            with open(path, "wb") as fh:
                fh.write(data)
            print("%-26s %8d B  %s" % (name, len(data), sha))
    if a.verify:
        print("verify: %d 个不一致" % len(bad))
        return 1 if bad else 0
    return 0


if __name__ == "__main__":
    sys.exit(main())
