from lib import *
W, H = 960, 470
b = [T(32, 44, '下载流程', 20, TXT, bold=True),
     T(32, 68, '每次响应在子请求预算内尽量多拼分片, 拼不完返回 206, 客户端按 Range 继续拉取剩余部分。', 13, SUB, maxw=900)]
steps = [('GET /f/:id', True, OR, ['签名直链, 分享, API', '可带 Range 请求头']),
         ('定位分片', False, TXT, ['按字节偏移计算', '起止分片与片内偏移']),
         ('读分片清单', False, PU, ['内存命中: D1 零读', '未命中: D1 读 1 行']),
         ('原生拼接输出', False, BL, ['FixedLengthStream', 'Worker CPU 几乎不参与'])]
for i, (t, mono, c, lines) in enumerate(steps):
    x = 32 + i * 230
    b.append(R(x, 92, 206, 96, CARD, STROKE, 12))
    b.append(badge(x + 24, 118, i + 1, c if c != TXT else SUB))
    b.append(T(x + 46, 124, t, 15, c if c != TXT else TXT, bold=not mono, mono=mono, maxw=150))
    for k, ln in enumerate(lines):
        b.append(T(x + 20, 152 + k * 22, ln, 12.5, SUB, maxw=176))
    if i < 3: b.append(A(x + 208, 140, x + 228, 140, MUTED))
# budget meter
b.append(T(32, 228, '子请求预算', 14, TXT, bold=True))
b.append(T(114, 228, 'SUBREQ_BUDGET = 48', 12.5, OR, mono=True))
b.append(T(928, 228, 'Free 计划单次调用上限 50, 留 2 个余量', 12, MUTED, 'end'))
b.append(R(32, 240, 896, 52, CARD, STROKE, 10))
groups = [1] * 8 + [2] * 20
x = 44
for gi, g in enumerate(groups):
    for k in range(g):
        col = PU if (g == 2 and k == 0) else BL
        b.append(R(x, 252, 14, 28, col, None, 3, op=0.9 if col == BL else 0.95))
        x += 16
    x += 4
assert x - 4 <= 920, x
b.append(R(32, 304, 12, 12, BL, None, 3)); b.append(T(52, 315, '下载分片 1 次', 12.5, SUB))
b.append(R(160, 304, 12, 12, PU, None, 3)); b.append(T(180, 315, 'getFile 1 次 (file_path 未缓存)', 12.5, SUB))
b.append(T(928, 315, '示例: 8 个热分片 + 20 个冷分片 = 48 次', 12, MUTED, 'end'))
stats = [('热分片', '1 次子请求, 单次响应最多 48 片, 约 912 MiB', BL),
         ('冷分片', '2 次子请求, 单次响应最多 24 片, 约 456 MiB', PU)]
for i, (k, v, c) in enumerate(stats):
    x = 32 + i * 452
    b.append(R(x, 330, 444, 40, CARD, None, 10))
    b.append(R(x, 330, 4, 40, c, None, 2))
    b.append(T(x + 18, 355, k, 13.5, c, bold=True))
    b.append(T(x + 76, 355, v, 13, SUB, maxw=356))
# range continuation
segs = [(32, 300, '响应 1: 206', OR), (336, 300, 'Range 续拉: 206', '#d9822b'), (640, 288, 'Range 续拉: 206', '#b8732f')]
for x, w, t, c in segs:
    b.append(R(x, 392, w, 30, c, None, 8, op=0.85))
    b.append(T(x + w / 2, 412, t, 12.5, BG, 'middle', True, maxw=w - 16))
for x in (332, 636):
    b.append(P(f'M{x-14},430 Q{x},446 {x+14},430', SUB, 1.4, extra=f' marker-end="url(#a{SUB.strip("#")})"'))
b.append(T(32, 458, '网页端, 播放器, 下载器会自动续拉; file_path 在内存缓存 50 分钟 (TG 保证至少 1 小时); Paid 计划可调大预算。', 12, MUTED, maxw=896))
write('download-flow', W, H + 4, b, 'HX-CF-Drive 下载流程')
print(WARN)
