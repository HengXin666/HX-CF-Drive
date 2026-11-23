-- HX-CF-Drive v0.2 结构。只用 TG, 不用 R2。
-- 设计目标: D1 写行最少。D1 的写行数包含索引, 所以索引只留必需的。
-- 约定: 时间均为 Unix 毫秒; id 为随机 base62 字符串

-- 目录树。根目录 id 固定为 'root'
CREATE TABLE nodes (
  id          TEXT PRIMARY KEY,
  parent_id   TEXT,
  name        TEXT NOT NULL,
  kind        TEXT NOT NULL CHECK (kind IN ('dir', 'file')),
  size        INTEGER NOT NULL DEFAULT 0,
  mime        TEXT,
  blob_id     TEXT,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  deleted_at  INTEGER
);
-- 同一目录下未删除的名字唯一, 同时用于按路径 O(1) 定位
CREATE UNIQUE INDEX idx_nodes_parent_name ON nodes(parent_id, name) WHERE deleted_at IS NULL;
-- 只有进回收站的行才进这个索引, 新建文件不产生额外写行
CREATE INDEX idx_nodes_deleted ON nodes(deleted_at) WHERE deleted_at IS NOT NULL;

INSERT INTO nodes (id, parent_id, name, kind, created_at, updated_at)
VALUES ('root', NULL, '', 'dir', 0, 0);

-- 实际存储对象。分片清单整体存成一行 JSON, 读一个文件只读 1 行。
-- manifest: [{"c":频道,"m":消息id,"b":botId,"f":file_id,"s":字节数}, ...]
-- 同 sha256 的文件共用一个 blob (秒传), 哈希由客户端本地计算
CREATE TABLE blobs (
  id          TEXT PRIMARY KEY,
  size        INTEGER NOT NULL,
  sha256      TEXT,
  chunk_size  INTEGER NOT NULL,
  manifest    TEXT NOT NULL,
  ref_count   INTEGER NOT NULL DEFAULT 1,
  created_at  INTEGER NOT NULL
);
CREATE UNIQUE INDEX idx_blobs_sha ON blobs(sha256) WHERE sha256 IS NOT NULL;
-- 只有引用归零 (待清理) 的才进索引
CREATE INDEX idx_blobs_orphan ON blobs(ref_count) WHERE ref_count <= 0;

-- Bot 池。冷却状态只放在 Worker 内存里, 这里只记 dead
CREATE TABLE bots (
  id          TEXT PRIMARY KEY,          -- Bot 数字 id (token 冒号前那段)
  token       TEXT NOT NULL,
  username    TEXT,
  status      TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'dead')),
  last_error  TEXT,
  created_at  INTEGER NOT NULL
);

-- 频道池 (私有频道, id 形如 -100xxxxxxxxxx)
CREATE TABLE channels (
  id          TEXT PRIMARY KEY,
  title       TEXT,
  status      TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'readonly', 'dead')),
  created_at  INTEGER NOT NULL
);

-- API 令牌 (只存哈希)
CREATE TABLE tokens (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  token_hash  TEXT NOT NULL UNIQUE,
  scopes      TEXT NOT NULL,                -- 逗号分隔: read,write,admin
  root_id     TEXT NOT NULL DEFAULT 'root', -- 只能访问该目录及其子目录
  expires_at  INTEGER,
  created_at  INTEGER NOT NULL
);

-- 分享链接
CREATE TABLE shares (
  id            TEXT PRIMARY KEY,
  node_id       TEXT NOT NULL,
  password_hash TEXT,
  expires_at    INTEGER,
  created_at    INTEGER NOT NULL
);
