-- 分享下载次数上限 (#22): 只有设了 max_downloads 的分享才计数, 每次下载写 1 行; 没设的不写。
-- 只加列, 不加索引; 读分享仍是按主键 1 行
ALTER TABLE shares ADD COLUMN max_downloads INTEGER;
ALTER TABLE shares ADD COLUMN downloads INTEGER NOT NULL DEFAULT 0;
