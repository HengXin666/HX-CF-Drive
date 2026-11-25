-- 多令牌隔离 (v0.3.1)
-- 1. 秒传按上传者隔离: blobs.owner 是登记哈希的令牌 id ('admin' 为管理员), 只有同一上传者或管理员登记的 blob 能被秒传, 防止伪造哈希投毒
-- 2. 分享记录创建它的令牌: 列表与删除按令牌范围隔离, 吊销令牌时一并删除它创建的分享
ALTER TABLE blobs ADD COLUMN owner TEXT;
UPDATE blobs SET owner = 'admin' WHERE sha256 IS NOT NULL;
DROP INDEX idx_blobs_sha;
CREATE UNIQUE INDEX idx_blobs_sha ON blobs(sha256, owner) WHERE sha256 IS NOT NULL;
ALTER TABLE shares ADD COLUMN token_id TEXT;
-- 3. 分享密码防爆破: 连续 10 次错误锁 15 分钟
ALTER TABLE shares ADD COLUMN fails INTEGER NOT NULL DEFAULT 0;
ALTER TABLE shares ADD COLUMN locked_until INTEGER;
-- 4. 累计计数 (tg_expired: 超过 48 小时删不掉而留在频道里的消息数, tg_failed: 删除失败数), 给 stats 看
CREATE TABLE counters (name TEXT PRIMARY KEY, n INTEGER NOT NULL DEFAULT 0) WITHOUT ROWID;
