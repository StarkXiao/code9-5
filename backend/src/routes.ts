import { Router } from "express";
import { authRouter } from "./modules/auth/routes";
import { categoriesRouter, adminCategoriesRouter } from "./modules/categories/routes";
import { spotsRouter, meRouter } from "./modules/spots/routes";
import { mediaRouter, moderationMediaRouter } from "./modules/media/routes";
import { moderationRouter } from "./modules/reviews/routes";
import { commentsRouter, moderationCommentsRouter } from "./modules/comments/routes";
import { suggestionsRouter, meSuggestionsRouter } from "./modules/suggestions/routes";
import { reportsRouter, moderationReportsRouter } from "./modules/reports/routes";
import { notificationsRouter } from "./modules/notifications/routes";
import { usersRouter } from "./modules/users/routes";
import { adminRouter } from "./modules/admin/routes";
import { REVIEW_REASON_CODES, REPORT_REASONS, NOTIFICATION_TYPES } from "./config/constants";
import { ok } from "./utils/serialize";
import { asyncHandler } from "./utils/asyncHandler";

// 所有业务路由挂载在 /api/v1 下。
// 公开只读路由放在前面便于阅读，实际匹配由 Express 路由表决定。
export function buildApiRouter(): Router {
  const router = Router();

  // 元数据：前端启动时拉一次，用于渲染筛选项与原因码选择器
  router.get(
    "/meta",
    asyncHandler(async (req, res) => {
      res.json(
        ok(req, {
          reviewReasonCodes: Object.entries(REVIEW_REASON_CODES).map(([code, label]) => ({ code, label })),
          reportReasons: Object.entries(REPORT_REASONS).map(([code, label]) => ({ code, label })),
          notificationTypes: Object.keys(NOTIFICATION_TYPES),
        }),
      );
    }),
  );

  router.use("/auth", authRouter);
  router.use(categoriesRouter);
  router.use(adminCategoriesRouter);
  router.use(spotsRouter);
  router.use(meRouter);
  router.use(mediaRouter);
  router.use(commentsRouter);
  router.use(suggestionsRouter);
  router.use(meSuggestionsRouter);
  router.use(reportsRouter);
  router.use(notificationsRouter);
  router.use(usersRouter);

  // 审核与管理侧
  router.use(moderationRouter);
  router.use("/moderation", moderationMediaRouter);
  router.use(moderationCommentsRouter);
  router.use(moderationReportsRouter);
  router.use(adminRouter);

  return router;
}
