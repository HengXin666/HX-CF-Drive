-- 孤儿消息清扫水位 (#7)。JSON: {"s": 已清扫到的 message id, "t": 记录 s 时的时间, "k": [[水位 id, 记录时间], ...]}
-- 上传路径零写入不变; 维护时每个频道每轮写 1 行
ALTER TABLE channels ADD COLUMN sweep TEXT;
