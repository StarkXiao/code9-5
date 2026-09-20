import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../../utils/asyncHandler";
import { ok } from "../../utils/serialize";
import { validate } from "../../middleware/validate";
import { optionalAuth, requireAuth } from "../../middleware/auth";
import { bigintParam } from "../../utils/params";
import { uuidParamSchema } from "../spots/schemas";
import {
  acceptSuggestion,
  dismissSuggestion,
  listMySuggestions,
  listSpotSuggestions,
} from "./service";

export const suggestionsRouter = Router();
export const meSuggestionsRouter = Router();

const pagedQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});

suggestionsRouter.get(
  "/spots/:uuid/suggestions",
  optionalAuth,
  validate({ params: uuidParamSchema, query: pagedQuery }),
  asyncHandler(async (req, res) => {
    res.json(ok(req, await listSpotSuggestions(req.params.uuid, req.user)));
  }),
);

meSuggestionsRouter.get(
  "/me/suggestions",
  requireAuth,
  validate({
    query: pagedQuery.extend({
      scope: z.enum(["incoming", "outgoing"]).default("incoming"),
      status: z.enum(["pending", "accepted", "dismissed", "expired"]).optional(),
    }),
  }),
  asyncHandler(async (req, res) => {
    const result = await listMySuggestions(req.user!, req.query as never);
    res.json(ok(req, result));
  }),
);

suggestionsRouter.post(
  "/suggestions/:id/accept",
  requireAuth,
  validate({ params: z.object({ id: z.coerce.bigint() }) }),
  asyncHandler(async (req, res) => {
    res.json(ok(req, await acceptSuggestion(bigintParam(req, "id"), req.user!)));
  }),
);

suggestionsRouter.post(
  "/suggestions/:id/dismiss",
  requireAuth,
  validate({
    params: z.object({ id: z.coerce.bigint() }),
    body: z.object({ reason: z.string().trim().max(200).optional() }),
  }),
  asyncHandler(async (req, res) => {
    res.json(ok(req, await dismissSuggestion(bigintParam(req, "id"), req.user!, req.body.reason)));
  }),
);
