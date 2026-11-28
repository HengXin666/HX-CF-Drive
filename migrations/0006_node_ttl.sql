-- 文件到期自动删除 (#22): 上传时可设 TTL, 到期后访问返回 410, 定时维护把它移进回收站。
-- 部分索引: 只有设了到期时间的行进索引, 普通上传不多写索引行
ALTER TABLE nodes ADD COLUMN expires_at INTEGER;
CREATE INDEX idx_nodes_expires ON nodes(expires_at) WHERE expires_at IS NOT NULL;
