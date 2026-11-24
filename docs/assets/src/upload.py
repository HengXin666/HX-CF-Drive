from lib import *
W, H = 960, 668
L = [('客户端', '浏览器 / hxd', 130, GR), ('Worker', 'Hono', 400, OR), ('D1', '目录树', 640, PU), ('Telegram', '私有频道', 850, BL)]
b = [T(32, 44, '上传流程', 20, TXT, bold=True),
     T(32, 68, '三步无状态上传: 分片阶段 D1 零读写, 进度由客户端保存的签名回执表示, 断开后可从任意片继续。', 13, SUB, maxw=900)]
bands = [(150, 326, '1  init', GR), (338, 484, '2  chunk x N', OR), (496, 654, '3  commit', PU)]
for y1, y2, lab, c in bands:
    b.append(R(20, y1, 920, y2 - y1, c, None, 12, op=0.06))
    b.append(R(20, y1, 4, y2 - y1, c, None, 2))
    b.append(T(34, y1 + 20, lab, 12, c, bold=True))
for name, sub, x, c in L:
    b.append(f'<line x1="{x}" y1="118" x2="{x}" y2="658" stroke="{MUTED}" stroke-dasharray="4 5" stroke-opacity="0.7"/>')
for name, sub, x, c in L:
    b.append(R(x - 70, 84, 140, 40, CARD, c, 10, 1.3))
    b.append(T(x, 103, name, 14, TXT, 'middle', True))
    b.append(T(x, 118, sub, 10.5, MUTED, 'middle'))
g1, g2, g3 = blend(GR, .06), blend(OR, .06), blend(PU, .06)
# init
b.append(R(70, 168, 120, 26, CARD2, GR, 7, 1))
b.append(T(130, 186, '本地算 sha256', 12, TXT, 'middle'))
b.append(msg(130, 400, 224, 'POST /uploads {size, sha256}', TXT, mono=True, size=11.5, bg=g1))
b.append(msg(400, 640, 246, '按 sha256 查重, 解析父目录', PU, bg=g1))
b.append(msg(640, 400, 268, '', PU, '5 4'))
b.append(msg(400, 130, 292, '命中: 秒传完成, 无需传分片', GR, '5 4', bg=g1))
b.append(msg(400, 130, 316, '未命中: 返回签名 ticket', OR, '5 4', bg=g1))
# chunk
b.append(pill(265, 362, '每片 19 MiB, 可并发, 可断点续传', 11.5, MUTED, bg=g2))
b.append(msg(130, 400, 396, 'PUT /uploads/chunk', TXT, mono=True, size=11.5, bg=g2))
b.append(msg(400, 850, 416, 'sendDocument, 请求体流式直通', BL, bg=g2))
b.append(msg(850, 400, 448, 'message_id, file_id', BL, '5 4', mono=True, size=11.5, bg=g2))
b.append(msg(400, 130, 472, '签名回执, D1 零读写', OR, '5 4', bg=g2))
# commit
b.append(msg(130, 400, 534, 'POST /uploads/commit', TXT, mono=True, size=11.5, sub='ticket + 全部回执', bg=g3))
b.append(R(330, 560, 140, 24, CARD2, OR, 7, 1))
b.append(T(400, 577, '校验回执签名', 12, TXT, 'middle'))
b.append(msg(400, 640, 616, '一次批量写: blob + node', PU, bg=g3))
b.append(msg(400, 130, 640, '返回文件节点', GR, '5 4', bg=g3))
write('upload-flow', W, H, b, 'HX-CF-Drive 上传流程')
print(WARN)
