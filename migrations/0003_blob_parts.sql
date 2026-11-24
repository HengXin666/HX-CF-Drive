-- 分段 manifest (#12)。分片数 > 256 的文件, 清单按 256 片一段拆成多行, blobs.manifest 存 {"parts":N}。
-- ≤ 256 片的文件仍是 blobs.manifest 一行, 不进这张表。WITHOUT ROWID: 每行只写 1 次 (没有额外的 rowid 索引)
CREATE TABLE blob_parts (
  blob_id  TEXT NOT NULL,
  idx      INTEGER NOT NULL,
  refs     TEXT NOT NULL,   -- 这一段的 ChunkRef 数组 JSON, 第 idx 段对应分片 [idx*256, idx*256+256)
  PRIMARY KEY (blob_id, idx)
) WITHOUT ROWID;
