-- 编辑已有分享 (#22): 启用 / 停用, 备注。改密码和有效期用原有列。
-- 只是加列 (默认值不回写旧行), 不新增索引; 读分享仍是按主键 1 行
ALTER TABLE shares ADD COLUMN disabled INTEGER NOT NULL DEFAULT 0;
ALTER TABLE shares ADD COLUMN remark TEXT;
