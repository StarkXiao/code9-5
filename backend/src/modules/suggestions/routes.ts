import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../../utils/asyncHandler";
import { ok } from "../../utils/serialize";
import { validate } from "../../middleware/validate";
import { requireAuth, requireActiveWriter } from "../../middleware/auth";
import { bigintParam } from "../../utils/params";
import { uuidParamSchema } from "../spots/schemas";
import {
  acceptSuggestion,
  listMyContributions,
  listMySuggestions,
  listSpotSuggestions,
  rejectSuggestion,
} from "./service";

export const suggestionsRouter = Router();

const pagedQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  status: z.enum(["pending", "accepted", "rejected", "expired"]).optional(),
});

const suggestionIdParam = z.object({ id: z.coerce.bigint() });

// 条目发布者：我收到的待确认补充
suggestionsRouter.get(
  "/me/suggestions",
  requireAuth,
  validate({ query: pagedQuery }),
  asyncHandler(async (req, res) => {
    const query = req.query as unknown as z.infer<typeof pagedQuery>;
    res.json(ok(req, await listMySuggestions(req.user!, query)));
  }),
);

// 评论作者：我贡献过的补充被采纳了吗
suggestionsRouter.get(
  "/me/suggestions/contributed",
  requireAuth,
  validate({ query: pagedQuery.pick({ page: true, pageSize: true }) }),
  asyncHandler(async (req, res) => {
    const query = req.query as unknown as { page: number; pageSize: number };
    res.json(ok(req, await listMyContributions(req.user!, query)));
  }),
);

// 条目详情页内联使用：该条目的全部待确认建议（仅作者/审核员）
suggestionsRouter.get(
  "/spots/:uuid/suggestions",
  requireAuth,
  validate({ params: uuidParamSchema }),
  asyncHandler(async (req, res) => {
    res.json(ok(req, await listSpotSuggestions(req.params.uuid, req.user!)));
  }),
);

suggestionsRouter.post(
  "/suggestions/:id/accept",
  requireAuth,
  requireActiveWriter,
  validate({ params: suggestionIdParam }),
  asyncHandler(async (req, res) => {
    res.json(ok(req, await acceptSuggestion(bigintParam(req, "id"), req.user!)));
  }),
);

suggestionsRouter.post(
  "/suggestions/:id/reject",
  requireAuth,
  validate({
    params: suggestionIdParam,
    body: z.object({ reason: z.string().trim().max(200).optional() }),
  }),
  asyncHandler(async (req, res) => {
    res.json(ok(req, await rejectSuggestion(bigintParam(req, "id"), req.user!, req.body.reason)));
  }),
);
