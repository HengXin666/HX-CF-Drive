from lib import *
b = []
b.append(T(32, 46, '架构总览', 20, TXT, bold=True))
b.append(T(32, 70, '一个 Worker, 一个 D1 数据库, 若干 Telegram 私有频道。没有 R2, 没有 Durable Object。', 13, SUB, maxw=880))
# clients
b.append(T(32, 110, '客户端', 12, MUTED, bold=True))
cl = [('浏览器', 'React 前端 (HX-UI)', OR), ('AI Agent', 'Skill, hxd 命令行', PU),
      ('WebDAV', 'rclone, Infuse, Finder', BL), ('图床工具', 'PicGo, ShareX', GR)]
for i, (t, s, c) in enumerate(cl):
    y = 122 + i * 76
    b.append(R(32, y, 180, 62, CARD, STROKE, 12))
    b.append(R(46, y + 14, 6, 34, c, None, 3))
    b.append(T(64, y + 28, t, 15, TXT, bold=True, maxw=140))
    b.append(T(64, y + 48, s, 12, SUB, maxw=140))
    b.append(A(212, y + 31, 250, y + 31, SUB))
# edge region
b.append(R(252, 96, 400, 410, OR, OR, 18, 1.4, '6 5', op=0.05))
b.append(T(272, 124, 'Cloudflare 边缘网络', 14, OR, bold=True))
b.append(R(272, 138, 360, 66, CARD, STROKE, 12))
b.append(T(290, 164, 'Static Assets', 15, TXT, bold=True))
b.append(T(400, 164, 'dist/web', 12, MUTED, mono=True))
b.append(T(290, 188, '命中静态文件直接返回, 不进 Worker, 不计请求', 12.5, SUB, maxw=330))
b.append(A(452, 204, 452, 234, OR))
b.append(T(462, 224, '未命中 /api /dav /f /s', 11.5, MUTED, mono=True))
b.append(R(272, 238, 360, 194, CARD, OR, 12, 1.2))
b.append(T(290, 266, 'Worker', 16, TXT, bold=True))
b.append(T(352, 266, 'Hono, TypeScript', 12, MUTED))
routes = [('/api/v1', 'REST API, 受限令牌'), ('/dav', 'WebDAV'), ('/f/:id', '签名永久直链'), ('/s/:id', '分享链接')]
for i, (p, d) in enumerate(routes):
    y = 282 + i * 26
    b.append(R(290, y, 82, 20, BG, STROKE, 6))
    b.append(T(331, y + 14, p, 11.5, OR, 'middle', mono=True, maxw=78))
    b.append(T(384, y + 15, d, 12.5, SUB, maxw=230))
b.append(f'<line x1="290" y1="392" x2="614" y2="392" stroke="{STROKE}"/>')
b.append(C(296, 412, 3, BL))
b.append(T(306, 416, 'isolate 内存缓存: 分片清单, file_path, 节点', 12.5, SUB, maxw=310))
b.append(R(272, 446, 360, 44, CARD, STROKE, 12))
b.append(P('M290,468 a8,8 0 1 0 16,0 a8,8 0 1 0 -16,0 M298,463 V468 L302,471', MUTED, 1.6))
b.append(T(316, 473, '每日维护: Bot 探活, 回收站清理, 删除孤儿分片', 12.5, SUB, maxw=300))
# D1
b.append(R(700, 122, 228, 150, CARD, PU, 14, 1.2))
b.append(P('M718,142 v16 a10,4 0 0 0 20,0 v-16 a10,4 0 0 0 -20,0 a10,4 0 0 0 20,0', PU, 1.6))
b.append(T(748, 155, 'D1', 16, TXT, bold=True))
b.append(T(774, 155, 'SQLite', 12, MUTED))
for i, (k, v) in enumerate([('nodes', '目录树与元数据'), ('blobs', '分片清单, 一行 JSON'), ('tokens', '受限 API 令牌'), ('bots', 'Bot 池与频道状态')]):
    y = 186 + i * 23
    b.append(T(718, y, k, 12, PU, mono=True))
    b.append(T(772, y, v, 12.5, SUB, maxw=148))
# TG
b.append(R(700, 296, 228, 210, CARD, BL, 14, 1.2))
b.append(P('M716,322 L740,312 L734,334 L728,326 Z', BL, 1.6))
b.append(T(748, 328, 'Telegram', 16, TXT, bold=True))
b.append(T(834, 328, 'Bot API', 12, MUTED))
for i in range(3):
    cx = 740 + i * 74
    b.append(C(cx, 366, 15, BL, op=0.16)); b.append(C(cx, 366, 15, 'none', BL, 1.4))
    b.append(T(cx, 371, f'Bot{i+1}', 10.5, BL, 'middle', True))
for j in range(2):
    x = 716 + j * 104
    b.append(R(x, 404, 92, 62, BG, STROKE, 9))
    b.append(T(x + 46, 422, f'私有频道 {"AB"[j]}', 11.5, SUB, 'middle', maxw=84))
    for k in range(3):
        b.append(R(x + 10 + k * 25, 432, 22, 22, BL, None, 4, op=0.55 - k * 0.12))
    for i in range(3):
        b.append(f'<line x1="{740+i*74}" y1="381" x2="{x+46}" y2="404" stroke="{BL}" stroke-opacity="0.35"/>')
b.append(T(814, 490, '每片 19 MiB, 文件名为随机 blob id', 11.5, MUTED, 'middle', maxw=210))
# links
b.append(A(632, 300, 698, 196, PU, mid=[(666, 300), (666, 196)]))
b.append(T(674, 252, 'SQL', 11, PU, mono=True))
b.append(A(632, 360, 698, 410, BL, mid=[(666, 360), (666, 410)]))
b.append(T(676, 400, '流式', 11, BL, 'start'))
write('architecture', 960, 530, b, 'HX-CF-Drive 架构图')
print(WARN)
