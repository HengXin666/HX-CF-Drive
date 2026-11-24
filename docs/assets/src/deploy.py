from lib import *
W, H = 960, 484
b = [T(32, 44, 'GitHub Actions 一键部署', 20, TXT, bold=True),
     T(32, 68, '你只需要完成上面 4 步, 下面的流水线由 .github/workflows/deploy.yml 自动执行。', 13, SUB, maxw=900)]
steps = [('Fork 仓库', OR, ['Fork 到自己的账号', 'HengXin666/HX-CF-Drive'], [False, True]),
         ('建 CF API 令牌', OR, ['模板: 编辑 Cloudflare Workers', '再加 账户 / D1 / 编辑'], [False, False]),
         ('填 Secrets 与变量', PU, ['Settings, Secrets and', 'variables, Actions'], [False, False]),
         ('Run workflow', BL, ['Actions, Deploy, 手动运行', '首次勾选 "登记频道"'], [False, False])]
for i, (t, c, lines, mono) in enumerate(steps):
    x = 32 + i * 228
    b.append(R(x, 90, 212, 104, CARD, STROKE, 12))
    b.append(f'<rect x="{x+16}" y="90" width="180" height="3" rx="1.5" fill="{c}"/>')
    b.append(badge(x + 28, 120, i + 1, c))
    b.append(T(x + 50, 126, t, 15.5, TXT, bold=True, maxw=150))
    for k, ln in enumerate(lines):
        b.append(T(x + 18, 154 + k * 22, ln, 12 if mono[k] else 12.5, OR if mono[k] else SUB, mono=mono[k], maxw=184))
    if i < 3: b.append(A(x + 214, 142, x + 226, 142, MUTED))
b.append(A(480, 198, 480, 226, OR, 2))
b.append(R(32, 232, 896, 176, OR, OR, 16, 1.2, '6 5', op=0.04))
b.append(T(52, 258, 'deploy.yml 自动执行', 13.5, OR, bold=True))
b.append(T(908, 258, '虚线 = 按配置可选', 12, MUTED, 'end'))
chips = [('检查 Secrets', 0), ('安装依赖', 0), ('类型检查 + 单测', 0), ('建 D1 或复用', 0), ('应用迁移', 0),
         ('自定义域名', 1), ('构建前端 + 部署', 0), ('写入 Worker 机密', 0), ('登记 Bot 与频道', 1), ('冒烟测试', 0)]
for i, (t, opt) in enumerate(chips):
    r, k = divmod(i, 5)
    x = 52 + k * 172; y = 272 + r * 70
    b.append(R(x, y, 156, 44, CARD, OR if not opt else MUTED, 10, 1, '5 4' if opt else None))
    b.append(T(x + 22, y + 27, str(i + 1).rjust(2, '0'), 11.5, OR if not opt else MUTED, 'middle', mono=True))
    b.append(T(x + 40, y + 27, t, 13, TXT, maxw=108))
    if k < 4: b.append(A(x + 157, y + 22, x + 170, y + 22, MUTED, 1.4))
b.append(A(52 + 4 * 172 + 78, 317, 52 + 78, 341, MUTED, 1.4, mid=[(52 + 4 * 172 + 78, 329), (52 + 78, 329)]))
res = [('部署地址', 'https://hx-cf-drive.<子域>.workers.dev', GR, True),
       ('每日维护', 'maintenance.yml 每天 19:00 UTC 调维护接口', BL, False)]
for i, (k, v, c, mono) in enumerate(res):
    x = 32 + i * 452
    b.append(R(x, 422, 444, 44, CARD, None, 10))
    b.append(R(x, 422, 4, 44, c, None, 2))
    b.append(T(x + 18, 449, k, 13.5, c, bold=True))
    b.append(T(x + 90, 449, v, 12 if mono else 13, SUB, mono=mono, maxw=340))
write('deploy-flow', W, H, b, 'GitHub Actions 部署流程')
print(WARN)
