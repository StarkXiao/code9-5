import {
  AUDIT_ACTIONS,
  ERROR_CODES,
  SUGGESTION_TTL_MS,
  SUGGESTIONS_PER_COMMENT,
} from "../../config/constants";
import { prisma, toJsonValue } from "../../db/prisma";
import { AppError } from "../../utils/errors";
import { parsePagination, pagedResult } from "../../utils/pagination";
import { notify } from "../../services/notify";
import { recordAudit } from "../../services/audit";
import { adjustCredit, CREDIT_DELTAS } from "../../services/moderation/credit";
import { extractFieldSuggestions } from "../../services/moderation/fieldExtractor";
import { validateAttributes, type AttributeSchema } from "../categories/schemaValidator";
import { getCategoryByCode } from "../categories/service";
import { logger } from "../../utils/logger";
import type { AuthUser } from "../../types/auth";

/**
 * 评论 → 字段建议 → 作者确认 → 写回条目（F11）。
 *
 * 识别本身是纯函数（fieldExtractor），本模块负责持久化、去重、通知、
 * 采纳时的 Schema 复核、修订快照与审计留痕。
 */

const SERIALIZABLE_FIELD_TYPES = ["boolean", "string", "integer", "array"] as const;
type SerializableFieldType = (typeof SERIALIZABLE_FIELD_TYPES)[number];

// ------------------------------------------------------------------ 识别与入库

/**
 * 对一条已可见的评论执行字段识别并落库。
 * 失败不阻断评论主流程——识别是增强能力，绝不能让评论发不出去。
 */
export async function ingestCommentSuggestions(comment: {
  id: bigint;
  spotId: bigint;
  userId: bigint;
  body: string;
}): Promise<number> {
  try {
    const spot = await prisma.spot.findUnique({
      where: { id: comment.spotId },
      select: {
        id: true,
        uuid: true,
        ownerId: true,
        title: true,
        status: true,
        attributes: true,
        category: {
          include: { schemas: { where: { isCurrent: true }, take: 1, select: { schema: true } } },
        },
      },
    });

    // 只对已发布条目、且评论者不是作者本人时识别
    if (!spot || spot.status !== "published" || spot.ownerId === comment.userId) return 0;

    const schemaRow = spot.category.schemas[0];
    if (!schemaRow) return 0;
    const schema = schemaRow.schema as unknown as AttributeSchema;

    const extracted = extractFieldSuggestions(
      comment.body,
      spot.category.code,
      schema,
      (spot.attributes ?? {}) as Record<string, unknown>,
    ).slice(0, SUGGESTIONS_PER_COMMENT);

    if (extracted.length === 0) return 0;

    const expiresAt = new Date(Date.now() + SUGGESTION_TTL_MS);
    let createdCount = 0;
    const created: Array<{ id: bigint; fieldLabel: string; valueLabel: string }> = [];

    for (const item of extracted) {
      // 同一（条目、字段）已有 pending 建议：把新原句追加进 evidence，不新建
      const existing = await prisma.fieldSuggestion.findFirst({
        where: { spotId: spot.id, fieldKey: item.fieldKey, status: "pending" },
        select: { id: true, evidence: true },
      });

      if (existing) {
        const evidence = Array.isArray(existing.evidence) ? (existing.evidence as string[]) : [];
        if (!evidence.includes(item.evidence)) {
          evidence.push(item.evidence);
          await prisma.fieldSuggestion.update({
            where: { id: existing.id },
            data: { evidence: toJsonValue(evidence.slice(-10)) },
          });
        }
        continue;
      }

      const row = await prisma.fieldSuggestion.create({
        data: {
          spotId: spot.id,
          commentId: comment.id,
          suggestedBy: comment.userId,
          fieldKey: item.fieldKey,
          fieldLabel: item.fieldLabel.slice(0, 48),
          fieldType: item.fieldType,
          proposedValue: toJsonValue(item.value),
          valueLabel: item.valueLabel.slice(0, 80),
          evidence: toJsonValue([item.evidence]),
          expiresAt,
        },
        select: { id: true, fieldLabel: true, valueLabel: true },
      });
      createdCount += 1;
      created.push(row);
    }

    // 同一评论的多条建议合并成一条通知，避免作者被连续 @
    if (created.length > 0) {
      const summary = created.map((item) => `${item.fieldLabel}：${item.valueLabel}`).join("；");
      await notify({
        userId: spot.ownerId,
        type: "field_suggested",
        title: "评论里有人补充了你记录的细节",
        body: `${spot.title}：${summary}。来看看是否采纳？`,
        payload: { spotUuid: spot.uuid, suggestionIds: created.map((item) => item.id.toString()) },
      });
    }

    return createdCount;
  } catch (error) {
    logger.warn(
      { err: (error as Error).message, commentId: comment.id.toString() },
      "评论字段建议识别失败（不影响评论本身）",
    );
    return 0;
  }
}

// ------------------------------------------------------------------ 读取

const listInclude = {
  comment: { select: { id: true, body: true, status: true } },
  commenter: { select: { uuid: true, nickname: true } },
  spot: { select: { uuid: true, title: true, status: true, category: { select: { code: true, name: true } } } },
} as const;

function serializeSuggestion(row: {
  id: bigint;
  status: string;
  fieldKey: string;
  fieldLabel: string;
  fieldType: string;
  proposedValue: unknown;
  valueLabel: string;
  evidence: unknown;
  decideReason: string | null;
  createdAt: Date;
  decidedAt: Date | null;
  expiresAt: Date;
  comment: { id: bigint; body: string; status: string } | null;
  commenter: { uuid: string; nickname: string } | null;
  spot: {
    uuid: string;
    title: string;
    status: string;
    category: { code: string; name: string };
  } | null;
}) {
  return {
    id: row.id.toString(),
    status: row.status,
    fieldKey: row.fieldKey,
    fieldLabel: row.fieldLabel,
    fieldType: row.fieldType,
    proposedValue: row.proposedValue,
    valueLabel: row.valueLabel,
    evidence: Array.isArray(row.evidence) ? row.evidence : [],
    decideReason: row.decideReason,
    createdAt: row.createdAt,
    decidedAt: row.decidedAt,
    expiresAt: row.expiresAt,
    expired: row.status === "pending" && row.expiresAt.getTime() < Date.now(),
    comment: row.comment ? { id: row.comment.id.toString(), body: row.comment.body, status: row.comment.status } : null,
    commenter: row.commenter,
    spot: row.spot
      ? {
          uuid: row.spot.uuid,
          title: row.spot.title,
          status: row.spot.status,
          categoryCode: row.spot.category.code,
          categoryName: row.spot.category.name,
        }
      : null,
  };
}

export async function listSpotSuggestions(spotUuid: string, viewer?: AuthUser) {
  const spot = await prisma.spot.findUnique({
    where: { uuid: spotUuid },
    select: { id: true, ownerId: true, status: true },
  });
  if (!spot || spot.status !== "published") throw AppError.notFound("该地点不存在或尚未发布");

  const isOwner = viewer?.id === spot.ownerId;
  const rows = await prisma.fieldSuggestion.findMany({
    where: {
      spotId: spot.id,
      // 公开只看到已采纳（且对应的是已发布条目上的最终事实）；作者看全部
      ...(isOwner ? {} : { status: "accepted" }),
    },
    orderBy: [{ status: "asc" }, { createdAt: "desc" }],
    take: 100,
    include: listInclude,
  });

  return { items: rows.map(serializeSuggestion) };
}

export async function listMySuggestions(
  user: AuthUser,
  query: { scope: "incoming" | "outgoing"; status?: string; page: number; pageSize: number },
) {
  const pagination = parsePagination(query);
  const baseWhere =
    query.scope === "outgoing"
      ? { suggestedBy: user.id }
      : { spot: { ownerId: user.id }, status: { not: "accepted" as const } };

  const where = {
    ...baseWhere,
    ...(query.status ? { status: query.status as never } : {}),
  };

  const [rows, total] = await Promise.all([
    prisma.fieldSuggestion.findMany({
      where,
      orderBy: [{ status: "asc" }, { createdAt: "desc" }],
      skip: pagination.skip,
      take: pagination.take,
      include: listInclude,
    }),
    prisma.fieldSuggestion.count({ where }),
  ]);

  return pagedResult(rows.map(serializeSuggestion), total, pagination);
}

// ------------------------------------------------------------------ 采纳 / 忽略

async function loadPendingForOwner(id: bigint, user: AuthUser) {
  const suggestion = await prisma.fieldSuggestion.findUnique({
    where: { id },
    include: {
      spot: {
        include: {
          category: {
            include: { schemas: { where: { isCurrent: true }, take: 1, select: { schema: true } } },
          },
        },
      },
    },
  });

  if (!suggestion) throw AppError.notFound("建议不存在");
  if (suggestion.spot.ownerId !== user.id) throw AppError.forbidden("只有条目发布者可以确认这条建议");
  if (suggestion.status !== "pending") {
    throw new AppError(
      409,
      ERROR_CODES.SUGGESTION_NOT_PENDING,
      `这条建议已经处理过了（当前状态：${suggestion.status}）`,
    );
  }
  if (suggestion.expiresAt.getTime() < Date.now()) {
    throw new AppError(409, ERROR_CODES.SUGGESTION_NOT_PENDING, "这条建议已过期");
  }
  if (suggestion.spot.status !== "published") {
    throw new AppError(
      422,
      ERROR_CODES.SPOT_STATE_INVALID,
      `条目当前状态为 ${suggestion.spot.status}，暂不能采纳建议`,
    );
  }

  return suggestion;
}

/** 构建一次写回的修订快照，结构与提交审核时保持一致 */
function buildWritebackSnapshot(params: {
  title: string;
  description: string | null;
  attributes: Record<string, unknown>;
  categoryCode: string;
  schemaVersion: number;
  suggestionId: bigint;
  commentId: bigint;
}) {
  return {
    title: params.title,
    description: params.description,
    attributes: params.attributes,
    categoryCode: params.categoryCode,
    categorySchemaVersion: params.schemaVersion,
    source: { type: "comment_suggestion", suggestionId: params.suggestionId.toString(), commentId: params.commentId.toString() },
  };
}

export async function acceptSuggestion(id: bigint, user: AuthUser) {
  const suggestion = await loadPendingForOwner(id, user);
  const spot = suggestion.spot;
  const category = await getCategoryByCode(spot.category.code);
  if (!category) throw AppError.unprocessable(ERROR_CODES.SPOT_STATE_INVALID, "条目分类已不可用");

  const schema = category.schema;
  const property = schema.properties[suggestion.fieldKey];

  // 字段可能在 Schema 新版本中被移除或改型——此时不能再写
  if (!property) {
    throw new AppError(
      422,
      ERROR_CODES.SPOT_ATTRIBUTE_REQUIRED,
      `属性「${suggestion.fieldLabel}」在当前分类 Schema 中已不存在，无法采纳`,
    );
  }
  if (!SERIALIZABLE_FIELD_TYPES.includes(suggestion.fieldType as SerializableFieldType)) {
    throw new AppError(422, ERROR_CODES.VALIDATION_FAILED, "建议值类型不受支持");
  }

  const value = suggestion.proposedValue as unknown;
  const nextAttributes: Record<string, unknown> = {
    ...((spot.attributes ?? {}) as Record<string, unknown>),
    [suggestion.fieldKey]: value,
  };

  // 写回前再校验一次：取值仍符合当前 Schema（含 enum / min / max）
  const result = validateAttributes(schema, nextAttributes);
  if (!result.ok) {
    throw new AppError(422, ERROR_CODES.SPOT_ATTRIBUTE_REQUIRED, result.errors[0]?.message ?? "建议值不符合当前属性定义", result.errors);
  }

  const lastRevision = await prisma.spotRevision.findFirst({
    where: { spotId: spot.id },
    orderBy: { revisionNo: "desc" },
    select: { revisionNo: true },
  });
  const revisionNo = (lastRevision?.revisionNo ?? 0) + 1;
  const now = new Date();

  // 写回条目 + 新修订快照 + 关闭建议，三件事必须同一事务
  const revision = await prisma.$transaction(async (tx) => {
    const created = await tx.spotRevision.create({
      data: {
        spotId: spot.id,
        revisionNo,
        editorId: user.id,
        schemaVersion: category.schemaVersion,
        snapshot: toJsonValue(
          buildWritebackSnapshot({
            title: spot.title,
            description: spot.description,
            attributes: nextAttributes,
            categoryCode: category.code,
            schemaVersion: category.schemaVersion,
            suggestionId: suggestion.id,
            commentId: suggestion.commentId,
          }),
        ),
      },
      select: { id: true, revisionNo: true },
    });

    await tx.spot.update({
      where: { id: spot.id },
      data: { attributes: toJsonValue(nextAttributes), currentRevisionId: created.id },
    });

    await tx.fieldSuggestion.update({
      where: { id: suggestion.id },
      data: { status: "accepted", decidedBy: user.id, decidedAt: now },
    });

    return created;
  });

  await recordAudit({
    actorId: user.id,
    action: AUDIT_ACTIONS.FIELD_SUGGESTION_ACCEPT,
    targetType: "field_suggestion",
    targetId: suggestion.id,
    before: { fieldKey: suggestion.fieldKey },
    after: { fieldKey: suggestion.fieldKey, value, revisionNo },
  });

  if (suggestion.suggestedBy !== user.id) {
    await adjustCredit(suggestion.suggestedBy, CREDIT_DELTAS.FIELD_SUGGESTION_ACCEPTED);
    await notify({
      userId: suggestion.suggestedBy,
      type: "field_suggestion_accepted",
      title: "你补充的细节被采纳了",
      body: `你在「${spot.title}」提到的「${suggestion.fieldLabel}：${suggestion.valueLabel}」已被发布者补充到条目里。`,
      payload: { spotUuid: spot.uuid, suggestionId: suggestion.id.toString() },
    });
  }

  logger.info(
    { suggestionId: suggestion.id.toString(), spotUuid: spot.uuid, revisionNo },
    "字段建议已采纳并写回条目",
  );

  return { status: "accepted" as const, revisionNo, attributes: { [suggestion.fieldKey]: value } };
}

export async function dismissSuggestion(id: bigint, user: AuthUser, reason?: string) {
  const suggestion = await loadPendingForOwner(id, user);
  const trimmed = reason?.trim().slice(0, 200) || null;
  const now = new Date();

  await prisma.fieldSuggestion.update({
    where: { id: suggestion.id },
    data: { status: "dismissed", decidedBy: user.id, decidedAt: now, decideReason: trimmed },
  });

  await recordAudit({
    actorId: user.id,
    action: AUDIT_ACTIONS.FIELD_SUGGESTION_DISMISS,
    targetType: "field_suggestion",
    targetId: suggestion.id,
    reason: trimmed ?? undefined,
    after: { fieldKey: suggestion.fieldKey, status: "dismissed" },
  });

  if (suggestion.suggestedBy !== user.id) {
    await notify({
      userId: suggestion.suggestedBy,
      type: "field_suggestion_dismissed",
      title: "你补充的一条细节未被采纳",
      body: trimmed
        ? `发布者回复：${trimmed}`
        : `你在「${suggestion.spot.title}」提到的「${suggestion.fieldLabel}」未被补充到条目。`,
      payload: { spotUuid: suggestion.spot.uuid, suggestionId: suggestion.id.toString() },
    });
  }

  return { status: "dismissed" as const };
}

// ------------------------------------------------------------------ 失效与清理

/** 评论被隐藏/删除时，其所有 pending 建议立即失效——依据没了，建议不能还挂着 */
export async function expireSuggestionsForComment(commentId: bigint): Promise<number> {
  const result = await prisma.fieldSuggestion.updateMany({
    where: { commentId, status: "pending" },
    data: { status: "expired", decidedAt: new Date(), decideReason: "来源评论已被隐藏或删除" },
  });
  return result.count;
}

/** 定时任务：30 天未处理的 pending 建议置为 expired */
export async function expireStaleSuggestions(): Promise<number> {
  const result = await prisma.fieldSuggestion.updateMany({
    where: { status: "pending", expiresAt: { lt: new Date() } },
    data: { status: "expired", decidedAt: new Date(), decideReason: "超过 30 天未处理，自动过期" },
  });
  return result.count;
}
