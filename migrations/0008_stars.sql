-- 收藏 / 星标 (#22): 按令牌各自收藏 (owner = 令牌 id, 管理员为 'admin')。
-- WITHOUT ROWID + 复合主键: 加星 1 行写, 取消 1 行删, 列收藏按主键前缀扫; 没用收藏的部署零开销
CREATE TABLE stars (
  owner      TEXT NOT NULL,
  node_id    TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (owner, node_id)
) WITHOUT ROWID;
