-- 评论细节提取：待条目发布者确认的字段建议
--
-- 与 20260102000000 一样，这条迁移为手工编写：
-- 不新增/改动 spots 上的高级索引，review 过 prisma migrate diff 的输出，
-- 确认没有 DROP INDEX idx_spots_* 后才提交。

CREATE TYPE "SuggestionStatus" AS ENUM ('pending', 'accepted', 'rejected', 'expired');

CREATE TABLE "spot_suggestions" (
    "id" BIGSERIAL NOT NULL,
    "spot_id" BIGINT NOT NULL,
    "field_key" VARCHAR(48) NOT NULL,
    "field_label" VARCHAR(48) NOT NULL,
    "field_type" VARCHAR(16) NOT NULL,
    "proposed_value" JSONB NOT NULL,
    "evidence" VARCHAR(120) NOT NULL,
    "status" "SuggestionStatus" NOT NULL DEFAULT 'pending',
    "source_comment_id" BIGINT NOT NULL,
    "source_user_id" BIGINT NOT NULL,
    "support_count" INTEGER NOT NULL DEFAULT 1,
    "decided_by" BIGINT,
    "decided_at" TIMESTAMPTZ(6),
    "decline_reason" VARCHAR(200),
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),

    CONSTRAINT "spot_suggestions_pkey" PRIMARY KEY ("id")
);

-- 同一条评论对同一字段只产生一条建议（重复出现时只累加 support_count）
CREATE UNIQUE INDEX "spot_suggestions_comment_field_key"
  ON "spot_suggestions"("source_comment_id", "field_key");

-- 条目发布者按状态查看待确认项
CREATE INDEX "idx_suggestions_spot"
  ON "spot_suggestions"("spot_id", "status", "created_at");

-- 评论作者查看"我的补充被采纳了吗"
CREATE INDEX "idx_suggestions_source"
  ON "spot_suggestions"("source_user_id", "status");

-- 定时任务扫描过期建议
CREATE INDEX "idx_suggestions_expire"
  ON "spot_suggestions"("expires_at") WHERE "status" = 'pending';

ALTER TABLE "spot_suggestions" ADD CONSTRAINT "spot_suggestions_spot_id_fkey"
  FOREIGN KEY ("spot_id") REFERENCES "spots"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "spot_suggestions" ADD CONSTRAINT "spot_suggestions_source_comment_id_fkey"
  FOREIGN KEY ("source_comment_id") REFERENCES "comments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "spot_suggestions" ADD CONSTRAINT "spot_suggestions_source_user_id_fkey"
  FOREIGN KEY ("source_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "spot_suggestions" ADD CONSTRAINT "spot_suggestions_decided_by_fkey"
  FOREIGN KEY ("decided_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
