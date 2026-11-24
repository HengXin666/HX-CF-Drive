from lib import *
W, H = 960, 452
b = [T(32, 44, '创建 Cloudflare API 令牌', 20, TXT, bold=True),
     T(32, 68, '我的个人资料, API 令牌, 创建令牌, 使用模板 "编辑 Cloudflare Workers", 再按下图补齐。', 13, SUB, maxw=900)]
X, Wp = 32, 576
b.append(R(X, 88, Wp, 348, CARD, STROKE, 14))
b.append(R(X, 88, Wp, 40, CARD2, None, 14))
b.append(f'<rect x="{X}" y="114" width="{Wp}" height="14" fill="{CARD2}"/>')
for i, c in enumerate(('#ff5f57', '#febc2e', '#28c840')):
    b.append(C(X + 22 + i * 16, 108, 5, c, op=0.8))
b.append(T(X + 82, 113, '编辑 Cloudflare Workers', 13, SUB))
b.append(T(X + 20, 154, '权限', 13, MUTED, bold=True))
cols = [X + 20, X + 112, X + 270]
rows = [('账户', 'Workers 脚本', '编辑', '模板自带', False),
        ('区域', 'Workers 路由', '编辑', '模板自带', False),
        ('...', '模板其余权限', '保持默认', '', False),
        ('账户', 'D1', '编辑', '手动添加', True)]
for i, (a, p, l, note, hi) in enumerate(rows):
    y = 166 + i * 40
    b.append(R(X + 14, y, Wp - 28, 32, OR if hi else BG, OR if hi else STROKE, 8, 1.2 if hi else 1, op=0.12 if hi else None))
    for j, v in enumerate((a, p, l)):
        b.append(R(cols[j], y + 6, (84, 148, 100)[j], 20, CARD, STROKE, 5))
        b.append(T(cols[j] + 10, y + 21, v, 12.5, TXT if hi or i != 2 else MUTED, maxw=(84, 148, 100)[j] - 14))
    if note:
        b.append(T(X + Wp - 28, y + 21, note, 12, OR if hi else MUTED, 'end', bold=hi))
b.append(T(X + 20, 350, '账户资源', 13, MUTED, bold=True))
b.append(T(X + 112, 350, '包括', 12.5, TXT)); b.append(T(X + 160, 350, '你的账户', 12.5, TXT))
b.append(T(X + 20, 384, '区域资源', 13, MUTED, bold=True))
b.append(T(X + 112, 384, '包括', 12.5, TXT)); b.append(T(X + 160, 384, '特定区域', 12.5, TXT))
b.append(R(X + 230, 368, 128, 22, BG, BL, 6, 1)); b.append(T(X + 294, 384, 'example.com', 12, BL, 'middle', mono=True))
b.append(T(X + 20, 418, '只在绑定自定义域名时需要指定域名所在区域, 不绑可选所有区域。', 12, MUTED, maxw=540))
# right
RX = 628; RW = 300
b.append(R(RX, 88, RW, 348, CARD, STROKE, 14))
b.append(T(RX + 20, 118, '权限用途与账户 ID', 15, TXT, bold=True))
items = [('Workers 脚本', OR, ['部署 Worker, 写入机密']),
         ('D1', PU, ['建库, 查 id, 执行迁移']),
         ('Workers 路由', BL, ['绑定 CUSTOM_DOMAIN']),
         ('账户 ID', GR, ['控制台首页右侧 Account ID', '存为 CLOUDFLARE_ACCOUNT_ID'])]
y = 150
for k, c, lines in items:
    b.append(C(RX + 26, y - 5, 5, c))
    b.append(T(RX + 40, y, k, 13.5, c, bold=True))
    for ln in lines:
        y += 22; b.append(T(RX + 40, y, ln, 12.5, SUB, maxw=RW - 56))
    y += 34
b.append(f'<line x1="{RX+20}" y1="372" x2="{RX+RW-20}" y2="372" stroke="{STROKE}"/>')
b.append(T(RX + 20, 398, '令牌只显示一次, 立即存为仓库', 12.5, SUB, maxw=RW - 40))
b.append(T(RX + 20, 420, 'Secret: CLOUDFLARE_API_TOKEN', 12.5, SUB, maxw=RW - 40))
write('cf-token', W, H, b, '创建 Cloudflare API 令牌')
print(WARN)
