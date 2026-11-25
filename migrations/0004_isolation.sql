-- 多令牌隔离 (v0.3.1)
-- 1. 秒传按上传者隔离: blobs.owner 是登记哈希的令牌 id ('admin' 为管理员), 只有同一上传者或管理员登记的 blob 能被秒传, 防止伪造哈希投毒
-- 2. 分享记录创建它的令牌: 列表与删除按令牌范围隔离, 吊销令牌时一并删除它创建的分享
ALTER TABLE blobs ADD COLUMN owner TEXT;
UPDATE blobs SET owner = 'admin' WHERE sha256 IS NOT NULL;
DROP INDEX idx_blobs_sha;
CREATE UNIQUE INDEX idx_blobs_sha ON blobs(sha256, owner) WHERE sha256 IS NOT NULL;
ALTER TABLE shares ADD COLUMN token_id TEXT;
