from lib import *
icons = {
 'cloud': lambda c: P('M12,31 H31 A7,7 0 0 0 31,17 A10,10 0 0 0 12.5,19 A6,6 0 0 0 12,31 Z', c),
 'stack': lambda c: P('M10,14 H34 V20 H10 Z M10,23 H34 V29 H10 Z M10,32 H34 V36 H10 Z', c, 1.8) ,
 'up': lambda c: P('M22,34 V11 M13,19 L22,10 L31,19 M12,36 H32', c),
 'down': lambda c: P('M22,9 V31 M13,23 L22,32 L31,23', c) + P('M10,37 H16 M19,37 H25 M28,37 H34', c, 2.4),
 'plug': lambda c: C(12,22,4.5,'none',c,2)+C(32,12,4.5,'none',c,2)+C(32,32,4.5,'none',c,2)+P('M16,20 L28,14 M16,24 L28,30',c),
 'term': lambda c: P('M8,11 H36 V33 H8 Z', c, 1.8) + P('M14,18 L19,22 L14,26 M22,27 H30', c),
}
cards = [
 ('cloud', OR, '全在 Cloudflare 上', 'Workers + D1 + Assets', ['免费计划即可运行, 不用 R2 与 DO', '静态前端由 Assets 直出, 不计请求']),
 ('stack', BL, 'Telegram 当块存储', 'Bot API, 19 MiB 分片', ['分片写进私有频道, 加频道即扩容', 'Bot 池 x 频道池, 失效自动重绑']),
 ('up', PU, '无状态分片上传', 'init, chunk, commit', ['chunk 阶段 D1 零读写, 流式直通', '签名回执断点续传, sha256 秒传']),
 ('down', BL, 'Range 拼片下载', 'FixedLengthStream', ['子请求预算内动态拼接多个分片', '超出返回 206, 客户端自动续拉']),
 ('plug', OR, '多种接入方式', 'REST, WebDAV, 直链, 分享', ['rclone, Infuse, Finder, RaiDrive', 'PicGo, ShareX, 受限 API 令牌']),
 ('term', PU, '为 AI Agent 准备', '/skill.md, /llms.txt', ['开箱即用的 Agent Skill', '零依赖命令行 hxd, 自动分片重试']),
]
b = []
W, H, G, P0 = 296, 156, 12, 24
for i, (ic, col, title, tag, lines) in enumerate(cards):
    x = P0 + (i % 3) * (W + G); y = P0 + (i // 3) * (H + G)
    b.append(R(x, y, W, H, CARD, STROKE, 14))
    b.append(f'<rect x="{x+18}" y="{y-1}" width="{W-36}" height="3" rx="1.5" fill="{col}"/>')
    b.append(R(x + 20, y + 22, 44, 44, col, None, 11, op=0.14))
    b.append(f'<g transform="translate({x+20},{y+22})">{icons[ic](col)}</g>')
    b.append(T(x + 78, y + 42, title, 17, TXT, bold=True, maxw=W - 92))
    b.append(T(x + 78, y + 62, tag, 12, col, mono=True, maxw=W - 92))
    b.append(f'<line x1="{x+20}" y1="{y+84}" x2="{x+W-20}" y2="{y+84}" stroke="{STROKE}"/>')
    for k, ln in enumerate(lines):
        b.append(C(x + 26, y + 104 + k * 26, 2.5, col))
        b.append(T(x + 36, y + 109 + k * 26, ln, 13.5, SUB, maxw=W - 52))
write('features', 936, P0 * 2 + H * 2 + G, b, 'HX-CF-Drive 特性')
print(WARN)
