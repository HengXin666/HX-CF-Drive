# Telegram 配置

## 1. 账号结构

```
存储小号 (频道所有者, 只做这一件事)
  ├─ 私有频道 A ── Bot1, Bot2, Bot3 (管理员)
  ├─ 私有频道 B ── Bot1, Bot2, Bot3 (管理员)
  └─ 主号 (管理员, 用于日常查看和兜底)
```

- 用一个专门的小号创建频道, 不要用主号, 也不要和签到, 群发之类的号混用。小号被封时主号作为管理员还在, 频道不会丢。
- 只用 Bot API, 不用 MTProto 和 session string。session string 等于整个账号的控制权, 泄露就是丢号。
- 建议 3 到 5 个 Bot, 1 到 3 个频道起步。

## 2. 创建 Bot

1. 在 Telegram 里找 `@BotFather`, 发 `/newbot`, 按提示起名, 拿到 token, 形如 `123456789:AAH...`。
2. 重复 3 到 5 次。
3. 每个 Bot 发一次 `/setjoingroups`, 选 Disable, 防止被别人拉进群。
4. 可选: `/setprivacy` 设 Enable。

## 3. 创建私有频道

1. 用存储小号: 新建频道, 类型选 **私有**, 不要设公开用户名。
2. 频道设置里关闭 "签名" 和 "讨论组"。
3. 频道设置, 管理员, 添加管理员, 搜索 Bot 用户名, 逐个添加, 至少勾选:
   - 发布消息 (Post Messages)
   - 删除消息 (Delete Messages), 不勾也能用, 但回收站清理时消息会留在频道里
4. 把主号也加为管理员。

## 4. 获取频道 ID

频道 ID 形如 `-100` 开头的一串数字。任选一种:

- 在频道里随便发一条消息, 然后访问 `https://api.telegram.org/bot<TOKEN>/getUpdates`, 找 `channel_post.chat.id`。需要先确认这个 Bot 没有设置 webhook。
- 网页版 `web.telegram.org/a/`, 打开频道, 地址栏 `#` 后面的数字, 前面补 `-100` (如果已经是 `-100` 开头就直接用)。

## 5. 接入 HX-CF-Drive

```bash
# 方式一: 部署时写进机密
npx wrangler secret put BOT_TOKENS # 123:AAA,456:BBB,789:CCC

# 方式二: 运行时添加 (会立即校验并报告在各频道的管理员状态)
curl -X POST -H "Authorization: Bearer $ADMIN" -H "Content-Type: application/json" \
  -d '{"token":"123:AAA"}' $BASE/api/v1/admin/bots

# 添加频道
curl -X POST -H "Authorization: Bearer $ADMIN" -H "Content-Type: application/json" \
  -d '{"id":"-1001234567890"}' $BASE/api/v1/admin/channels
```

## 6. 限制与风控 (已在代码里处理)

| 官方限制 | 来源 | 本项目的做法 |
| --- | --- | --- |
| sendDocument 最大 50 MB | Bot API 文档 | 固定 19 MiB 分片 |
| getFile 最大 20 MB | Bot API 文档 | 同上 |
| file_path 至少有效 1 小时 | Bot API 文档 | 缓存 50 分钟 |
| 群组内每分钟不超过 20 条 | Bot FAQ | 不做服务端排队: TG 返回 429 时原样转给客户端, 客户端按 Retry-After 等待, 下次换 Bot |
| 429 带 retry_after | Bot API 文档 | 该 Bot 在当前 isolate 内冷却 retry_after x 1.2, 期间不再选它 |
| file_id 只对拿到它的 Bot 有效 | 实际行为 | 分片记录 bot_id; Bot 失效时用另一个 Bot 转发原消息拿新 file_id |

其他做法:

- 只用 `sendDocument` 并关闭类型识别, 防止被当成图片或视频压缩。
- 分片文件名是随机 blob id, 不带原始文件名, 频道里看不出内容是什么。
- 401/403 视为 Bot 失效, 标记 dead, 每天探活一次, 恢复后自动启用。

## 7. 扩容

- 上传慢或频繁 429: 加频道。写入按 blob id 哈希打散到所有 active 频道, 吞吐线性提升。
- 单个 Bot 被限: 加 Bot, 所有 Bot 都要是每个频道的管理员。
- 频道太满或想冻结: `PATCH /api/v1/admin/channels/:id {"status":"readonly"}`, 只读不写, 已有文件照常读取。

## 8. 出问题时

| 现象 | 处理 |
| --- | --- |
| 添加频道时某个 Bot 显示 `NOT ADMIN` | 回频道把它加为管理员并勾选发布消息 |
| 上传一直 429 | 加 Bot 或频道; 客户端降低并发 (网页端默认 2 路) |
| 某个 Bot 被封 | 不用处理。读取时自动换 Bot 重新绑定; 可以用 `DELETE /api/v1/admin/bots/:id` 下线 |
| 存储小号被封 | 主号仍是管理员, 频道还在。新建小号, 主号把它加为管理员即可 |
| 频道被删除 | 只有这种情况会丢数据。重要文件请另存一份, 多频道冗余在后续版本 |
