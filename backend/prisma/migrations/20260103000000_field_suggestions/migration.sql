-- F11 评论细节字段建议
--
-- 从可见评论中识别出的结构化细节（如"有靠背""免费"），
-- 整理成待补充字段推给条目发布者；采纳后写回 spots.attributes。
--
-- 本迁移为手工编写：field_suggestions 是新表，不触碰 init 迁移末尾
-- 那三个 Prisma 表达不了的手工索引（trgm / GIN / 部分索引）。

CREATE TYPE "suggestion_status" AS ENUM ('pending', 'accepted', 'dismissed', 'expired');

CREATE TABLE "field_suggestions" (
    "id" BIGSERIAL PRIMARY KEY,
    "spot_id" BIGINT NOT NULL REFERENCES "spots"("id") ON DELETE CASCADE,
    "comment_id" BIGINT NOT NULL REFERENCES "comments"("id") ON DELETE CASCADE,
    "suggested_by" BIGINT NOT NULL REFERENCES "users"("id"),
    "field_key" VARCHAR(48) NOT NULL,
    "field_label" VARCHAR(48) NOT NULL,
    "field_type" VARCHAR(16) NOT NULL,
    "proposed_value" JSONB NOT NULL,
    "value_label" VARCHAR(80) NOT NULL,
    "evidence" JSONB NOT NULL DEFAULT '[]'::jsonb,
    "status" "suggestion_status" NOT NULL DEFAULT 'pending',
    "decided_by" BIGINT REFERENCES "users"("id"),
    "decide_reason" VARCHAR(200),
    "decided_at" TIMESTAMPTZ(6),
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now()
);

-- 同一（条目、字段）同时只允许一条待处理建议
CREATE UNIQUE INDEX "idx_field_suggestion_pending"
  ON "field_suggestions"("spot_id", "field_key") WHERE "status" = 'pending';
CREATE INDEX "idx_field_suggestion_owner"
  ON "field_suggestions"("spot_id", "status", "created_at" DESC);
CREATE INDEX "idx_field_suggestion_user"
  ON "field_suggestions"("suggested_by", "status", "created_at" DESC);
CREATE INDEX "idx_field_suggestion_comment" ON "field_suggestions"("comment_id");
CREATE INDEX "idx_field_suggestion_expiry"
  ON "field_suggestions"("expires_at") WHERE "status" = 'pending';
