import { Prisma, type SuggestionStatus } from "@prisma/client";
import {
  AUDIT_ACTIONS,
  ERROR_CODES,
  PENDING_SUGGESTIONS_PER_SPOT,
  SUGGESTIONS_PER_COMMENT,
  SUGGESTION_TTL_MS,
} from "../../config/constants";
import { prisma, toJsonValue, asRecord } from "../../db/prisma";
import { AppError } from "../../utils/errors";
import { parsePagination, pagedResult } from "../../utils/pagination";
import { notify } from "../../services/notify";
import { recordAudit } from "../../services/audit";
import { logger } from "../../utils/logger";
import { validateAttributes, type AttributeSchema } from "../categories/schemaValidator";
import { extractDetailsFromText } from "../../services/detail-extraction";
import type { AuthUser } from "../../types/auth";
import { isModerator } from "../../types/auth";

// ------------------------------------------------------------------ 提取与入库

interface CommentForExtraction {
  id: bigint;
  body: string;
  userId: bigint;
}

/**
 * 一条评论进入公开状态后，尝试从其中提取结构化字段建议。
 * 失败不影响评论主流程——评论已经发出去了，不能因为建议服务出错让用户评论失败。
 */
export async function extractSuggestionsFromComment(
  spotId: bigint,
  comment: CommentForExtraction,
): Promise<number> {
  try {
    return await runExtraction(spotId, comment);
  } catch (error) {
    // 建议是评论的"增值"而不是评论本身：任何失败都不能让已发出的评论报错
    logger.error(
      { err: (error as Error).message, spotId: spotId.toString(), commentId: comment.id.toString() },
      "评论细节提取失败",
    );
    return 0;
  }
}

async function runExtraction(
  spotId: bigint,
  comment: CommentForExtraction,
): Promise<number> {
  const spot = await prisma.spot.findUnique({
    where: { id: spotId },
    include: { category: { include: { schemas: { where: { isCurrent: true }, take: 1 } } } },
  });
  if (!spot || spot.status !== "published") return 0;
  // 作者自己评论自己的条目不算"补充"，避免作者借评论通道绕过编辑流程
  if (spot.ownerId === comment.userId) return 0;

  const schema = spot.category.schemas[0];
  if (!schema) return 0;

  const extracted = extractDetailsFromText(
    comment.body,
    schema.schema as unknown as AttributeSchema,
    asRecord(spot.attributes),
  ).slice(0, SUGGESTIONS_PER_COMMENT);

  if (extracted.length === 0) return 0;

  const pendingCount = await prisma.spotSuggestion.count({
    where: { spotId, status: "pending" },
  });
  let capacity = Math.max(0, PENDING_SUGGESTIONS_PER_SPOT - pendingCount);

  let created = 0;
  const fieldLabels: string[] = [];

  for (const item of extracted) {
    // 同一字段已有待确认建议时不重复建，找到的同值建议累加支持数
    const existing = await prisma.spotSuggestion.findFirst({
      where: { spotId, fieldKey: item.fieldKey, status: "pending" },
    });

    if (existing) {
      const sameValue = JSON.stringify(existing.proposedValue) === JSON.stringify(item.proposedValue);
      if (sameValue) {
        await prisma.spotSuggestion.update({
          where: { id: existing.id },
          data: { supportCount: { increment: 1 } },
        });
      }
      // 不同取值的同字段建议：发布者先看到的那条先决断，被驳回/采纳后再来的才有机会，
      // 避免同一字段挂三条互相矛盾的建议
      continue;
    }

    if (capacity === 0) break;

    const property = (schema.schema as unknown as AttributeSchema).properties[item.fieldKey];
    try {
      await prisma.spotSuggestion.create({
        data: {
          spotId,
          fieldKey: item.fieldKey,
          fieldLabel: property?.label ?? item.fieldKey,
          fieldType: item.fieldType,
          proposedValue: toJsonValue(item.proposedValue),
          evidence: item.evidence,
          sourceCommentId: comment.id,
          sourceUserId: comment.userId,
          expiresAt: new Date(Date.now() + SUGGESTION_TTL_MS),
        },
      });
    } catch (error) {
      // (comment, field) 有唯一约束，并发下另一条评论已抢先建单时跳过即可
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === "P2002"
      ) {
        continue;
      }
      throw error;
    }
    created += 1;
    capacity -= 1;
    fieldLabels.push(property?.label ?? item.fieldKey);
  }

  if (created > 0) {
    await notify({
      userId: spot.ownerId,
      type: "detail_suggestion",
      title: "评论里有人补充了新的现场细节",
      body: `${fieldLabels.join("、")}：等你确认后会自动补充到「${spot.title}」`,
      payload: { spotUuid: spot.uuid, fields: fieldLabels },
    });
  }

  return created;
}

// ------------------------------------------------------------------ 读取

const suggestionInclude = {
  spot: {
    select: {
      uuid: true,
      title: true,
      ownerId: true,
      status: true,
      category: { select: { code: true, name: true } },
    },
  },
  sourceUser: { select: { uuid: true, nickname: true } },
} satisfies Prisma.SpotSuggestionInclude;

export function serializeSuggestion(
  row: Prisma.SpotSuggestionGetPayload<{ include: typeof suggestionInclude }>,
) {
  return {
    id: row.id,
    spotUuid: row.spot.uuid,
    spotTitle: row.spot.title,
    category: { code: row.spot.category.code, name: row.spot.category.name },
    status: row.status,
    fieldKey: row.fieldKey,
    fieldLabel: row.fieldLabel,
    fieldType: row.fieldType,
    proposedValue: row.proposedValue,
    evidence: row.evidence,
    supportCount: row.supportCount,
    declineReason: row.declineReason,
    sourceCommentId: row.sourceCommentId,
    sourceUser: row.sourceUser ? { nickname: row.sourceUser.nickname } : null,
    decidedAt: row.decidedAt,
    expiresAt: row.expiresAt,
    createdAt: row.createdAt,
  };
}

/** 条目发布者看待确认列表（/me/suggestions） */
export async function listMySuggestions(
  user: AuthUser,
  query: { status?: SuggestionStatus; page: number; pageSize: number },
) {
  const pagination = parsePagination(query);
  const where: Prisma.SpotSuggestionWhereInput = {
    spot: { ownerId: user.id, deletedAt: null },
    ...(query.status ? { status: query.status } : {}),
  };

  // 待确认状态排最前；SuggestionStatus 的枚举序（accepted/expired/...）
  // 不支持"pending 优先"的语义，在应用层稳定排序
  const orderBy: Prisma.SpotSuggestionOrderByWithRelationInput[] = query.status
    ? [{ supportCount: "desc" }, { createdAt: "desc" }]
    : [{ createdAt: "desc" }];

  const [rows, total] = await Promise.all([
    prisma.spotSuggestion.findMany({
      where,
      include: suggestionInclude,
      orderBy,
      skip: pagination.skip,
      take: pagination.take,
    }),
    prisma.spotSuggestion.count({ where }),
  ]);

  const items = query.status
    ? rows
    : [...rows].sort((a, b) => {
        if ((a.status === "pending") !== (b.status === "pending")) {
          return a.status === "pending" ? -1 : 1;
        }
        return b.supportCount - a.supportCount;
      });

  return pagedResult(items.map(serializeSuggestion), total, pagination);
}

/** 条目详情页：只有作者能看到挂起的建议，其他人看不到，避免未核实信息外显 */
export async function listSpotSuggestions(spotUuid: string, user: AuthUser) {
  const spot = await prisma.spot.findUnique({ where: { uuid: spotUuid }, select: { id: true, ownerId: true } });
  if (!spot) throw AppError.notFound("该地点不存在");
  if (spot.ownerId !== user.id && !isModerator(user)) {
    throw AppError.forbidden("只有条目发布者能查看待确认细节");
  }

  const items = await prisma.spotSuggestion.findMany({
    where: { spotId: spot.id, status: "pending" },
    include: suggestionInclude,
    orderBy: { createdAt: "desc" },
  });

  return { items: items.map(serializeSuggestion) };
}

/** 评论作者看自己贡献过哪些、被采纳了没有 */
export async function listMyContributions(user: AuthUser, query: { page: number; pageSize: number }) {
  const pagination = parsePagination(query);
  const where: Prisma.SpotSuggestionWhereInput = { sourceUserId: user.id };

  const [items, total] = await Promise.all([
    prisma.spotSuggestion.findMany({
      where,
      include: suggestionInclude,
      orderBy: { createdAt: "desc" },
      skip: pagination.skip,
      take: pagination.take,
    }),
    prisma.spotSuggestion.count({ where }),
  ]);

  return pagedResult(items.map(serializeSuggestion), total, pagination);
}

// ------------------------------------------------------------------ 确认写回

async function loadDecidableSuggestion(id: bigint, user: AuthUser) {
  const suggestion = await prisma.spotSuggestion.findUnique({
    where: { id },
    include: {
      spot: {
        include: { category: { include: { schemas: { where: { isCurrent: true }, take: 1 } } } },
      },
      sourceUser: { select: { id: true, nickname: true } },
    },
  });
  if (!suggestion) throw AppError.notFound("这条补充建议不存在");
  if (suggestion.spot.ownerId !== user.id && !isModerator(user)) {
    throw AppError.forbidden("只有条目发布者能确认这条补充");
  }
  if (suggestion.status !== "pending") {
    throw AppError.unprocessable(
      ERROR_CODES.SPOT_STATE_INVALID,
      `这条建议已经处理过（${suggestion.status}）`,
    );
  }
  if (suggestion.expiresAt.getTime() < Date.now()) {
    await prisma.spotSuggestion.update({ where: { id }, data: { status: "expired" } });
    throw AppError.unprocessable(ERROR_CODES.SPOT_STATE_INVALID, "这条建议已过期");
  }
  return suggestion;
}

/**
 * 采纳建议：校验取值仍符合当前 Schema，合并进 spot.attributes。
 * 这是"自动写回原始条目"的唯一入口——直接 UPDATE，不重新走审核，
 * 因为作者本人确认等同于作者自己编辑；但合并规则只允许补空字段，
 * 不覆盖作者已有的值（见提取阶段的跳过逻辑 + 这里的二次防御）。
 */
export async function acceptSuggestion(id: bigint, user: AuthUser) {
  const suggestion = await loadDecidableSuggestion(id, user);
  const { spot } = suggestion;

  const schema = spot.category.schemas[0];
  if (!schema) throw AppError.unprocessable(ERROR_CODES.SPOT_STATE_INVALID, "分类属性配置缺失，无法写回");

  const attributes = asRecord(spot.attributes);
  // proposed_value 列直接存标量/数组值（布尔、枚举字符串、整数、字符串数组）
  const nextValue: unknown = suggestion.proposedValue;

  if (attributes[suggestion.fieldKey] !== undefined && attributes[suggestion.fieldKey] !== null) {
    // 作者后来自己填了：不抢作者的内容，建议转为失效
    await prisma.spotSuggestion.update({
      where: { id },
      data: { status: "expired", decidedBy: user.id, decidedAt: new Date(), declineReason: "作者已自行填写该字段" },
    });
    throw AppError.unprocessable(
      ERROR_CODES.SPOT_STATE_INVALID,
      "这个字段你已经填写过了，建议已自动失效",
    );
  }

  const merged = { ...attributes, [suggestion.fieldKey]: nextValue };
  const result = validateAttributes(schema.schema as unknown as AttributeSchema, merged);
  if (!result.ok) {
    throw AppError.unprocessable(
      ERROR_CODES.SPOT_ATTRIBUTE_REQUIRED,
      `建议的取值不再符合当前属性配置：${result.errors[0]?.message ?? ""}`,
      result.errors,
    );
  }

  const now = new Date();
  const before = { attributes };
  await prisma.$transaction([
    prisma.spot.update({ where: { id: spot.id }, data: { attributes: toJsonValue(merged) } }),
    prisma.spotSuggestion.update({
      where: { id },
      data: { status: "accepted", decidedBy: user.id, decidedAt: now },
    }),
    // 同字段的其他待确认建议一律失效：作者已表态，矛盾建议不再悬挂
    prisma.spotSuggestion.updateMany({
      where: { spotId: spot.id, fieldKey: suggestion.fieldKey, status: "pending", id: { not: id } },
      data: { status: "expired", decidedBy: user.id, decidedAt: now, declineReason: "同字段已有建议被采纳" },
    }),
  ]);

  await recordAudit({
    actorId: user.id,
    action: AUDIT_ACTIONS.SUGGESTION_ACCEPT,
    targetType: "spot_suggestion",
    targetId: id,
    before,
    after: { attributes: merged },
    reason: `采纳评论补充：${suggestion.fieldLabel}`,
  });

  if (suggestion.sourceUserId !== user.id) {
    await notify({
      userId: suggestion.sourceUserId,
      type: "detail_accepted",
      title: "你补充的现场细节被采纳了",
      body: `你在「${spot.title}」评论里提到的"${suggestion.fieldLabel}"已由发布者确认并补充到条目里，谢谢！`,
      payload: { spotUuid: spot.uuid, fieldKey: suggestion.fieldKey },
    });
  }

  return {
    id,
    status: "accepted" as const,
    fieldKey: suggestion.fieldKey,
    attributes: merged,
  };
}

export async function rejectSuggestion(id: bigint, user: AuthUser, reason?: string) {
  const suggestion = await loadDecidableSuggestion(id, user);
  const now = new Date();

  await prisma.spotSuggestion.update({
    where: { id },
    data: { status: "rejected", decidedBy: user.id, decidedAt: now, declineReason: reason?.slice(0, 200) ?? null },
  });

  await recordAudit({
    actorId: user.id,
    action: AUDIT_ACTIONS.SUGGESTION_REJECT,
    targetType: "spot_suggestion",
    targetId: id,
    after: { status: "rejected", reason: reason ?? null },
  });

  if (suggestion.sourceUserId !== user.id && reason) {
    await notify({
      userId: suggestion.sourceUserId,
      type: "detail_rejected",
      title: "你补充的细节未被采纳",
      body: `「${suggestion.spot.title}」的发布者回复：${reason}`,
      payload: { spotUuid: suggestion.spot.uuid, fieldKey: suggestion.fieldKey },
    });
  }

  return { id, status: "rejected" as const };
}

// ------------------------------------------------------------------ 定时过期

/** 超时未处理的待确认建议自动失效，由每日 cleanup 任务调用 */
export async function expireSuggestions(): Promise<{ expired: number }> {
  const result = await prisma.spotSuggestion.updateMany({
    where: { status: "pending", expiresAt: { lt: new Date() } },
    data: { status: "expired" },
  });
  return { expired: result.count };
}
