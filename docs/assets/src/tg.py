from lib import *
W, H = 960, 400
b = [T(32, 44, 'Telegram 准备', 20, TXT, bold=True),
     T(32, 68, '用一个专门的存储小号建私有频道, 只用 Bot API, 不用 MTProto 和 session string。', 13, SUB, maxw=900)]
cards = [('建 Bot', ['找 @BotFather 发 /newbot', '建 3 到 5 个, 记下 token', '/setjoingroups 选 Disable']),
         ('建私有频道', ['用存储小号新建频道', '类型选私有, 不设用户名', '关闭签名与讨论组']),
         ('Bot 设管理员', ['频道设置, 管理员, 添加', '逐个添加全部 Bot', '主号也设为管理员兜底']),
         ('取频道 id', ['网页版打开频道, 地址栏', '# 后的数字前补 -100', '或 getUpdates 的 chat.id'])]
for i, (t, lines) in enumerate(cards):
    x = 32 + i * 228
    b.append(R(x, 90, 212, 206, CARD, STROKE, 12))
    b.append(f'<rect x="{x+16}" y="90" width="180" height="3" rx="1.5" fill="{BL}"/>')
    b.append(badge(x + 28, 122, i + 1, BL))
    b.append(T(x + 50, 128, t, 15.5, TXT, bold=True, maxw=150))
    for k, ln in enumerate(lines):
        b.append(T(x + 18, 160 + k * 24, ln, 12.5, SUB, maxw=180))
    cy = 242
    b.append(R(x + 16, cy, 180, 36, BG, STROKE, 8))
    if i == 0:
        b.append(T(x + 106, cy + 23, '123456789:AAH...', 12, BL, 'middle', mono=True))
    elif i == 1:
        b.append(P(f'M{x+34},{cy+16} v-3 a6,6 0 0 1 12,0 v3 M{x+31},{cy+16} h18 v11 h-18 z', BL, 1.5))
        b.append(T(x + 60, cy + 23, '私有, 无公开链接', 12.5, TXT))
    elif i == 2:
        for j, lab in enumerate(('发布消息', '删除消息')):
            bx = x + 28 + j * 86
            b.append(R(bx, cy + 11, 14, 14, BL, None, 3))
            b.append(P(f'M{bx+3},{cy+18} l3,3 l5,-6', BG, 2))
            b.append(T(bx + 20, cy + 23, lab, 12, TXT))
    else:
        b.append(T(x + 106, cy + 23, '-1001234567890', 12.5, OR, 'middle', mono=True))
    if i < 3: b.append(A(x + 214, 193, x + 226, 193, MUTED))
maps = [('Bot token, 逗号分隔', 'BOT_TOKENS', BL), ('-100 开头的频道 id', 'TG_CHANNEL_ID', OR)]
for i, (k, v, c) in enumerate(maps):
    x = 32 + i * 452
    b.append(R(x, 316, 444, 52, CARD, None, 10))
    b.append(R(x, 316, 4, 52, c, None, 2))
    b.append(T(x + 20, 347, k, 13.5, TXT, maxw=180))
    b.append(A(x + 214, 342, x + 250, 342, c))
    b.append(R(x + 262, 328, 164, 28, BG, c, 7))
    b.append(T(x + 344, 347, v, 12.5, c, 'middle', mono=True))
b.append(T(32, 390, '两个值都存为 GitHub 仓库 Secret; Bot 也可以部署后在后台添加。', 12, MUTED, maxw=900))
write('telegram-setup', W, H, b, 'Telegram 准备步骤')
print(WARN)
