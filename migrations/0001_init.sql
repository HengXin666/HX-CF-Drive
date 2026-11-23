-- HX-CF-Drive 初始结构
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
-- 同一目录下未删除的名字唯一
CREATE UNIQUE INDEX idx_nodes_parent_name ON nodes(parent_id, name) WHERE deleted_at IS NULL;
CREATE INDEX idx_nodes_blob ON nodes(blob_id);
CREATE INDEX idx_nodes_deleted ON nodes(deleted_at) WHERE deleted_at IS NOT NULL;

INSERT INTO nodes (id, parent_id, name, kind, created_at, updated_at)
VALUES ('root', NULL, '', 'dir', 0, 0);

-- 实际存储对象。同 sha256 的文件共用一个 blob (秒传)
CREATE TABLE blobs (
  id          TEXT PRIMARY KEY,
  driver      TEXT NOT NULL CHECK (driver IN ('r2', 'tg')),
  size        INTEGER NOT NULL,
  sha256      TEXT,
  chunk_size  INTEGER NOT NULL,
  chunk_count INTEGER NOT NULL,
  r2_key      TEXT,
  channel_id  TEXT,
  ref_count   INTEGER NOT NULL DEFAULT 1,
  status      TEXT NOT NULL DEFAULT 'ready' CHECK (status IN ('uploading', 'ready', 'purging')),
  created_at  INTEGER NOT NULL
);
CREATE UNIQUE INDEX idx_blobs_sha ON blobs(sha256) WHERE sha256 IS NOT NULL AND status = 'ready';

-- TG 分片索引。file_id 只对上传它的 Bot 有效, 所以记录 bot_id
CREATE TABLE chunks (
  blob_id     TEXT NOT NULL,
  idx         INTEGER NOT NULL,
  size        INTEGER NOT NULL,
  channel_id  TEXT NOT NULL,
  message_id  INTEGER NOT NULL,
  bot_id      TEXT NOT NULL,
  file_id     TEXT NOT NULL,
  PRIMARY KEY (blob_id, idx)
);

-- Bot 池
CREATE TABLE bots (
  id          TEXT PRIMARY KEY,          -- Bot 数字 id (token 冒号前那段)
  token       TEXT NOT NULL,
  username    TEXT,
  status      TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'cooldown', 'dead')),
  fail_count  INTEGER NOT NULL DEFAULT 0,
  retry_until INTEGER NOT NULL DEFAULT 0,
  last_error  TEXT,
  created_at  INTEGER NOT NULL
);

-- 频道池 (私有频道, id 形如 -100xxxxxxxxxx)
CREATE TABLE channels (
  id          TEXT PRIMARY KEY,
  title       TEXT,
  status      TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'readonly', 'dead')),
  msg_count   INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL
);

-- 分片上传会话 (断点续传)
CREATE TABLE upload_sessions (
  id          TEXT PRIMARY KEY,
  parent_id   TEXT NOT NULL,
  name        TEXT NOT NULL,
  size        INTEGER NOT NULL,
  mime        TEXT,
  sha256      TEXT,
  blob_id     TEXT NOT NULL,
  driver      TEXT NOT NULL,
  chunk_size  INTEGER NOT NULL,
  chunk_count INTEGER NOT NULL,
  r2_upload_id TEXT,
  r2_parts    TEXT NOT NULL DEFAULT '[]',   -- JSON: [{partNumber, etag}]
  received    INTEGER NOT NULL DEFAULT 0,   -- 已收分片数
  overwrite   INTEGER NOT NULL DEFAULT 0,
  created_by  TEXT,
  expires_at  INTEGER NOT NULL
);
CREATE INDEX idx_sessions_expires ON upload_sessions(expires_at);

-- API 令牌 (只存哈希)
CREATE TABLE tokens (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  token_hash  TEXT NOT NULL UNIQUE,
  scopes      TEXT NOT NULL,                -- 逗号分隔: read,write,admin
  root_id     TEXT NOT NULL DEFAULT 'root', -- 只能访问该目录及其子目录
  expires_at  INTEGER,
  created_at  INTEGER NOT NULL,
  last_used_at INTEGER
);

-- 分享链接
CREATE TABLE shares (
  id            TEXT PRIMARY KEY,
  node_id       TEXT NOT NULL,
  password_hash TEXT,
  expires_at    INTEGER,
  download_count INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL
);

-- 操作日志
CREATE TABLE audit_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  actor      TEXT NOT NULL,
  action     TEXT NOT NULL,
  node_id    TEXT,
  detail     TEXT,
  at         INTEGER NOT NULL
);
CREATE INDEX idx_audit_at ON audit_log(at);
