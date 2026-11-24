import json, math
from lib import *

d = json.load(open('docs/bench/2026-11-25.json'))
PH = {p['key']: p for p in d['phases']}

# ---------- 图 1: 各接口实测 (客户端耗时 / Worker CPU / D1 行) ----------
ops = [
    ('stat', '按路径 stat', 12, 0),
    ('list', '列目录 50 项', 59, 0),
    ('search', '模糊搜索', 113, 0),
    ('range', 'Range 读 1KB', 1, 0),
    ('link', '直链 /f 300KB', 0.4, 0),
    ('upload_small', '上传 300KB', 9, 5.3),
    ('upload_chunk', '分片上传 (每请求)', 3, 1.5),
    ('download', '完整下载 40MB', 2, 0),
]
W, H = 960, 600
b = [T(40, 50, '线上实测: 每个接口的开销', 24, TXT, bold=True),
     T(40, 78, f'2026-11-25, Workers Free, 单 Bot 单频道, 共 {sum(p["requests"] for p in d["phases"])} 次请求。CPU 来自 CF GraphQL, 按分钟对齐。', 13, SUB)]
x0, y0, rh = 40, 130, 46
cols = [(x0, '接口'), (230, '客户端耗时 p50'), (470, 'Worker CPU p50 / p99'), (760, 'D1 行 读 / 写')]
for x, s in cols: b.append(T(x, y0 - 14, s, 13, MUTED, bold=True))
lat_max = 3500
for i, (k, name, rr, rw) in enumerate(ops):
    p = PH[k]; y = y0 + i * rh
    b.append(R(x0 - 12, y, W - 2 * x0 + 24, rh - 8, CARD if i % 2 == 0 else BG, None, 8))
    cy = y + (rh - 8) / 2 + 5
    b.append(T(x0, cy, name, 14, TXT))
    # 耗时条
    v = p['p50']; bw = min(v, lat_max) / lat_max * 150
    b.append(R(230, cy - 11, max(bw, 3), 14, 'url(#gBl)', None, 4))
    lab = f'{v / 1000:.0f} s' if v > 10000 else f'{v} ms'
    b.append(T(230 + max(bw, 3) + 8, cy, lab + (' (经代理)' if k == 'download' else ''), 12.5, SUB))
    # CPU 条, 10ms 刻度 = 200px
    c50, c99 = p['cpu_p50'] / 1000, p['cpu_p99'] / 1000
    sc = 200 / 20
    b.append(R(470, cy - 11, min(c99, 20) * sc, 14, blend(OR, 0.35), None, 4))
    b.append(R(470, cy - 11, c50 * sc, 14, 'url(#gOr)', None, 4))
    b.append(T(680, cy, f'{c50:.1f} / {c99:.1f} ms', 12.5, SUB))
    b.append(T(760, cy, f'{rr:g} / {rw:g}', 13, TXT, mono=True))
# 10ms 线
lx = 470 + 10 * 10
b.append(f'<line x1="{lx}" y1="{y0 - 6}" x2="{lx}" y2="{y0 + len(ops) * rh - 8}" stroke="{OR}" stroke-dasharray="4 4" stroke-width="1.2"/>')
b.append(T(lx, y0 + len(ops) * rh + 10, 'Free 10ms', 11.5, OR, 'middle'))
yb = y0 + len(ops) * rh + 40
b.append(T(40, yb, 'CPU 中位数都在 1 到 6 ms, 上传和 Range 的 p99 偶尔超过 10 ms (冷启动), 本次 0 错误。', 12.5, SUB, maxw=900))
b.append(T(40, yb + 22, '完整下载 40MB 慢在测试机经代理的带宽, Worker 本身只用了 6.2 ms CPU。', 12.5, SUB, maxw=900))
write('bench-ops', W, H, b, '线上实测: 每个接口的开销')

# ---------- 图 2: 用量随读写量线性增长 ----------
LIM_REQ, LIM_R, LIM_W = 100_000, 5_000_000, 100_000
W2, H2 = 960, 490
b = [T(40, 50, '读写量每涨一点, 哪项额度先见底', 24, TXT, bold=True),
     T(40, 78, '按实测单价线性外推, 纵轴为占 Free 日额度的百分比。下载按每文件一次直链, 上传按每文件 1 次 init+commit 加每 19 MiB 一片。', 13, SUB, maxw=900)]

def chart(ox, oy, cw, ch, xmax, xlabel, series, ticks, title=''):
    o = [R(ox - 50, oy - 50, cw + 80, ch + 110, CARD, STROKE, 12), T(ox - 30, oy - 24, title, 14, TXT, bold=True)]
    for t in (0, 25, 50, 75, 100):
        y = oy + ch - t / 100 * ch
        o.append(f'<line x1="{ox}" y1="{y}" x2="{ox + cw}" y2="{y}" stroke="{STROKE}" stroke-width="1"/>')
        o.append(T(ox - 8, y + 4, f'{t}%', 11, MUTED, 'end'))
    for t in ticks:
        x = ox + t / xmax * cw
        o.append(T(x, oy + ch + 18, f'{t}', 11, MUTED, 'middle'))
    o.append(T(ox + cw / 2, oy + ch + 38, xlabel, 12, SUB, 'middle'))
    for name, color, f in series:
        pts = []
        for i in range(101):
            x = xmax * i / 100; v = f(x)
            if v > 100:
                pts.append((ox + x / xmax * cw, oy)); break
            pts.append((ox + x / xmax * cw, oy + ch - v / 100 * ch))
        o.append(P('M' + ' L'.join(f'{a:.1f},{c:.1f}' for a, c in pts), color, 2.4))
    ly = oy + 8
    for name, color, f in series:
        o.append(R(ox + 10, ly - 9, 14, 4, color, None, 2)); o.append(T(ox + 30, ly - 3, name, 11.5, SUB)); ly += 18
    return o

MB = 1024
dl = lambda S: (lambda g: g * MB / S / LIM_REQ * 100)
b += chart(90, 170, 330, 230, 500, '每日下载量 (GB)', [
    ('平均 2 MB 图片', BL, dl(2)), ('平均 20 MB', PU, dl(20)), ('平均 200 MB 视频', GR, dl(200))], (0, 100, 200, 300, 400, 500), '下载: Workers 请求数')
# 上传: 小文件 1 请求 + 写 6 行; 大文件 init+commit+片
up_req = lambda S: (lambda g: g * MB / S * (1 if S < 19 else 2 + math.ceil(S / 19)) / LIM_REQ * 100)
up_w = lambda S: (lambda g: g * MB / S * 6 / LIM_W * 100)
b += chart(560, 170, 330, 230, 50, '每日上传量 (GB)', [
    ('2 MB 文件 D1 写', OR, up_w(2)), ('2 MB 文件 请求数', BL, up_req(2)), ('20 MB 文件 D1 写', PU, up_w(20)), ('20 MB 文件 请求数', GR, up_req(20))], (0, 10, 20, 30, 40, 50), '上传: D1 写入与 Workers 请求')
write('bench-scale', W2, H2, b, '读写量与额度')

# ---------- 图 3: 作者场景的日用量 ----------
D, U, S = 100, 10, 20
files_dl = D * MB / S
files_up = U * MB / S
req = files_dl + files_up * (2 + math.ceil(S / 19)) + 500 * 2
reads = files_dl * 2 + files_up * 9 + 500 * 59
writes = files_up * 6
rows = [('Workers 请求', req, LIM_REQ, '10 万/天'), ('D1 行读', reads, LIM_R, '500 万/天'), ('D1 行写', writes, LIM_W, '10 万/天'), ('R2', 0, 1, '不使用')]
W3, H3 = 960, 370
b = [T(40, 50, '日常场景的日用量', 24, TXT, bold=True),
     T(40, 78, f'每天下载 {D} GB, 上传 {U} GB, 平均文件 {S} MB, 外加 500 次打开目录。按实测单价计算。', 13, SUB)]
for i, (n, v, lim, ls) in enumerate(rows):
    y = 120 + i * 50
    pct = v / lim * 100 if lim > 1 else 0
    b.append(T(40, y + 16, n, 14, TXT))
    b.append(R(170, y + 2, 560, 20, CARD, STROKE, 6))
    if lim > 1: b.append(R(170, y + 2, max(560 * pct / 100, 4), 20, 'url(#gOr)' if pct > 20 else 'url(#gBl)', None, 6))
    b.append(T(745, y + 17, f'{pct:.1f}%' if lim > 1 else '0', 13, TXT, bold=True))
    b.append(T(810, y + 17, f'{v:,.0f} / {ls}' if lim > 1 else ls, 12, MUTED))
b.append(T(40, 345, '结论: 下载看 Workers 请求数, 文件越小越先见底; 大量小文件上传看 D1 写入; D1 读和 R2 基本可以忽略。', 12.5, SUB, maxw=900))
write('bench-budget', W3, H3, b, '日常场景的日用量')
print(WARN, round(req), round(reads), round(writes))
