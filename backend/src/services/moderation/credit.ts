import { prisma } from "../../db/prisma";

const MIN_CREDIT = 0;
const MAX_CREDIT = 100;

export const CREDIT_DELTAS = {
  SPOT_APPROVED: 2,
  SPOT_REJECTED: -8,
  SPOT_AUTO_REJECTED_OVERRIDE: -5,
  COMMENT_HIDDEN: -10,
  REPORT_CONFIRMED_ON_USER: -15,
  APPEAL_UPHELD: 6,
  FIELD_SUGGESTION_ACCEPTED: 2,
} as const;

export function clampCredit(value: number): number {
  return Math.max(MIN_CREDIT, Math.min(MAX_CREDIT, Math.round(value)));
}

/** 调整信用分，钳制在 0–100 */
export async function adjustCredit(userId: bigint, delta: number): Promise<number> {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { creditScore: true } });
  if (!user) return MIN_CREDIT;

  const next = clampCredit(user.creditScore + delta);
  if (next === user.creditScore) return next;

  await prisma.user.update({ where: { id: userId }, data: { creditScore: next } });
  return next;
}

export async function incrementApprovedCount(userId: bigint): Promise<void> {
  await prisma.user.update({
    where: { id: userId },
    data: { approvedCount: { increment: 1 } },
  });
}

/**
 * 计算新鲜度分数：基础分 50 + 确认数×10 − 天数衰减 − 过期上报×15。
 * 与文档第 9.4 节保持一致。
 */
export function computeFreshness(params: {
  confirmCount: number;
  staleReportCount: number;
  lastConfirmedAt: Date | null;
  publishedAt: Date | null;
  now?: Date;
}): number {
  const now = params.now ?? new Date();
  const reference = params.lastConfirmedAt ?? params.publishedAt;
  const days = reference ? Math.floor((now.getTime() - reference.getTime()) / 86400000) : 365;
  const decay = Math.max(0, Math.floor(days / 30)) * 10;

  const raw = 50 + params.confirmCount * 10 - decay - params.staleReportCount * 15;
  return clampCredit(raw);
}
