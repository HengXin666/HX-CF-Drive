# 与市面方案对比

数据取自 GitHub (2026-11-24), star 数会变化。

## 1. 候选项目

| 项目 | Star | 语言 / 许可 | 运行环境 | 元数据 | TG 接入方式 | 定位 |
| --- | --- | --- | --- | --- | --- | --- |
| [OpenList](https://github.com/OpenListTeam/OpenList) | 25.8k | Go | 自有服务器 | SQLite/MySQL | 不直接存 TG | 多网盘聚合挂载, WebDAV |
| [CloudFlare-ImgBed](https://github.com/MarSeventh/CloudFlare-ImgBed) | 6.9k | JS / MIT | CF Pages, Workers, Docker | KV, D1, SQLite | Bot API, 单片 20 MB 分片 | 图床 + 文件管理, 多渠道 |
| [Telegram-Drive](https://github.com/caamer20/Telegram-Drive) | 5.8k | 桌面客户端 | 本地 | 本地 | 真人账号 | 本地客户端, 无服务端 |
| [Telegraph-Image](https://github.com/cf-pages/Telegraph-Image) | 4.7k | HTML | CF Pages | KV | Bot API | 轻量图床 |
| [Teldrive](https://github.com/tgdrive/teldrive) | 3.2k | Go | 自有服务器 | PostgreSQL | 真人账号 + Bot 池 | 网盘, rclone 集成 |
| [Pentaract](https://github.com/Dominux/Pentaract) | 1.9k | Rust / MIT | 自有服务器 | PostgreSQL | Bot API | 网盘 |
| [tgState](https://github.com/csznet/tgState) | 1.0k | Go | 自有服务器 | 无 | Bot API | 单文件图床/网盘 |

## 2. 成熟方案的共同设计

1. **元数据和文件分离**。所有项目都把目录树放在数据库 (D1, KV, PostgreSQL), TG 只当块存储。HX-CF-Drive 相同。
2. **Bot API 分片 ≤ 20 MB**。ImgBed, Pentaract, tgState 都受 getFile 20 MB 限制切片。HX-CF-Drive v0.2 用 19 MiB。
3. **真人账号换大文件和速度**。Teldrive 和 Telegram-Drive 用 MTProto, 单片可到 GB 级, 但要长连接服务器, 有封号风险。Workers 上做不了, 所以全 CF 方案只能走 Bot API。
4. **多渠道负载均衡 + 失败切换**。ImgBed 支持多个 TG, R2, S3, Discord 渠道轮换, 上传失败自动换渠道。HX-CF-Drive 有 Bot 池 x 频道池, v0.2 起只用 TG。
5. **挂载层单独做**。OpenList 不管存储, 只负责把各种后端挂成统一目录和 WebDAV。

## 3. 和 HX-CF-Drive 的对比

| 能力 | CloudFlare-ImgBed | Teldrive | HX-CF-Drive |
| --- | --- | --- | --- |
| 全部跑在 CF 免费计划 | 是 | 否 (要服务器 + PG) | 是 |
| TG 大文件分片 | 是 | 是 (MTProto) | 是 |
| R2 / S3 | R2, S3 | 否 | R2 |
| 其他后端 | Discord, HF, WebDAV | 否 | 否 |
| 目录, 搜索, WebDAV, Range | 是 | 目录, rclone | 是 |
| 细粒度 API 令牌 | 是 | 未核实 | 是 (含目录隔离) |
| Web 管理界面 | 完整 | 完整 | 极简 |
| 内容审核, AI 标签, 图片处理 | 是 | 否 | 否 |
| 全局限速 | 未核实 | 不适用 | v0.2 去掉 DO, 改为客户端按 429 重试 |
| sha256 秒传 | 未核实 | 未核实 | 是 |
| Bot 失效自动换 Bot 重新绑定 | 未核实 | 未核实 | 是 |
| 社区与维护 | 6.9k star, 2026-11 仍在更新 | 3.2k star | 个人项目, 未上线验证 |

## 4. 结论

- 面向人用的图床 / 网盘, CloudFlare-ImgBed 更成熟, 界面更全, 渠道更多。
- 给别的服务当存储后端 (Service Binding 调用, 按目录隔离的令牌, 引用计数, 立即彻底删除, 令牌吊销即作废它签的直链), 这些是 HX-CF-Drive 的定位, ImgBed 文档里没有对应说明。HX-AIOA 的大文件渠道按这个定位接入 (HX-AIOA #88)。
- 要单文件 GB 级, 高吞吐, 或任意时间都能删除 TG 消息, 只能用 Teldrive 这类 MTProto 方案, 代价是常驻服务器和真人账号的封号风险。
- 表中 "未核实" 是没有在对方文档里找到说明, 不代表没有, 选型前以其文档为准: https://cfbed.sanyue.de/guide/features.html
