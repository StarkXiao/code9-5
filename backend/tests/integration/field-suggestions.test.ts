import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { createApp } from "../../src/app";
import { prisma } from "../../src/db/prisma";
import { initStorage } from "../../src/services/storage";

// F11 评论细节字段建议闭环（文档 5.6b / A16）：
// 评论 → 识别 → 推送作者 → 采纳写回 + 修订快照 → 评论者收通知；
// 以及忽略、重复建议去重、评论隐藏后建议过期等分支。
let app: Express;
let ownerToken = "";
let commenterToken = "";
let moderatorToken = "";
let ownerUuid = "";
let commenterUuid = "";
let moderatorUuid = "";

const suffix = Date.now().toString(36);
const ownerEmail = `sug-owner-${suffix}@example.com`;
const commenterEmail = `sug-commenter-${suffix}@example.com`;
const moderatorEmail = `sug-mod-${suffix}@example.com`;
const password = "Str0ngPass1";

async function login(account: string): Promise<{ token: string; uuid: string }> {
  const response = await request(app).post("/api/v1/auth/login").send({ account, password }).expect(200);
  const me = await request(app)
    .get("/api/v1/auth/me")
    .set("Authorization", `Bearer ${response.body.data.accessToken}`)
    .expect(200);
  return { token: response.body.data.accessToken, uuid: me.body.data.user.uuid };
}

beforeAll(async () => {
  await initStorage();
  app = createApp();

  await request(app)
    .post("/api/v1/auth/register")
    .send({ email: ownerEmail, password, nickname: `条目作者${suffix.slice(-4)}` })
    .expect(201);
  await request(app)
    .post("/api/v1/auth/register")
    .send({ email: commenterEmail, password, nickname: `补充者${suffix.slice(-4)}` })
    .expect(201);
  await request(app)
    .post("/api/v1/auth/register")
    .send({ email: moderatorEmail, password, nickname: `审核员${suffix.slice(-4)}` })
    .expect(201);

  await prisma.user.update({ where: { email: moderatorEmail }, data: { role: "moderator" } });
  // 评论者直接给到高信用分 + 足够的历史通过评论数，使其评论走"先发后审"即时可见
  await prisma.user.update({
    where: { email: commenterEmail },
    data: { creditScore: 100, approvedCount: 5 },
  });

  ownerToken = (await login(ownerEmail)).token;
  const commenter = await login(commenterEmail);
  commenterToken = commenter.token;
  commenterUuid = commenter.uuid;
  const moderator = await login(moderatorEmail);
  moderatorToken = moderator.token;
  moderatorUuid = moderator.uuid;
  ownerUuid = (await request(app).get("/api/v1/auth/me").set("Authorization", `Bearer ${ownerToken}`)).body.data.user
    .uuid;

  // 先发后审要求"信用分 ≥ 阈值 且 库中 visible 评论 ≥ 3"，
  // 直接插 3 条 visible 评论帮测试账号跨过冷启动（这些评论不经过识别服务）。
  const bootstrap = await request(app)
    .post("/api/v1/spots")
    .set("Authorization", `Bearer ${ownerToken}`)
    .send({
      categoryCode: "bench",
      title: `信任 bootstrap ${suffix.slice(-4)}`,
      attributes: { has_backrest: true, condition: "good" },
      lat: 30.3,
      lng: 120.7,
      mediaUuids: [],
    })
    .expect(201);
  const bootstrapSpot = await prisma.spot.findUniqueOrThrow({ where: { uuid: bootstrap.body.data.uuid } });
  const commenterRow = await prisma.user.findUniqueOrThrow({ where: { uuid: commenterUuid } });
  await prisma.comment.createMany({
    data: [1, 2, 3].map((i) => ({
      spotId: bootstrapSpot.id,
      userId: commenterRow.id,
      body: `bootstrap 可见评论 ${i}`,
      status: "visible" as const,
    })),
  });
}, 60000);

afterAll(async () => {
  const users = [ownerUuid, commenterUuid, moderatorUuid].filter(Boolean);
  const records = await prisma.user.findMany({ where: { uuid: { in: users } }, select: { id: true } });
  const ids = records.map((record) => record.id);

  if (ids.length > 0) {
    await prisma.fieldSuggestion.deleteMany({ where: { suggestedBy: { in: ids } } });
    await prisma.comment.deleteMany({ where: { userId: { in: ids } } });
    await prisma.spot.deleteMany({ where: { ownerId: { in: ids } } });
    await prisma.mediaAsset.deleteMany({ where: { ownerId: { in: ids } } });
    await prisma.user.deleteMany({ where: { id: { in: ids } } });
  }

  await prisma.$disconnect();
}, 60000);

async function publishBench(title: string, attributes: Record<string, unknown>): Promise<string> {
  const created = await request(app)
    .post("/api/v1/spots")
    .set("Authorization", `Bearer ${ownerToken}`)
    .send({
      categoryCode: "bench",
      title,
      description: "F11 集成测试条目",
      attributes,
      lat: 30.2 + Math.random() * 0.01,
      lng: 120.6 + Math.random() * 0.01,
      fuzzEnabled: true,
      fuzzRadiusM: 50,
      mediaUuids: [],
    })
    .expect(201);

  const submitted = await request(app)
    .post(`/api/v1/spots/${created.body.data.uuid}/submit`)
    .set("Authorization", `Bearer ${ownerToken}`)
    .expect(200);
  const taskId = submitted.body.data.taskId as string;

  await request(app)
    .post(`/api/v1/moderation/tasks/${taskId}/claim`)
    .set("Authorization", `Bearer ${moderatorToken}`)
    .expect(200);
  const approved = await request(app)
    .post(`/api/v1/moderation/tasks/${taskId}/approve`)
    .set("Authorization", `Bearer ${moderatorToken}`)
    .send({ reason: "测试发布" })
    .expect(200);
  expect(approved.body.data.status).toBe("published");

  return created.body.data.uuid as string;
}

describe("F11 评论细节字段建议闭环", () => {
  it("高信用评论即时可见，并为作者产生字段建议", async () => {
    const spotUuid = await publishBench(`建议测试长椅${suffix.slice(-4)}`, {
      has_backrest: true,
      condition: "good",
    });

    const posted = await request(app)
      .post(`/api/v1/spots/${spotUuid}/comments`)
      .set("Authorization", `Bearer ${commenterToken}`)
      .send({ body: "这个长椅是木头做的，正午很晒，没树荫" })
      .expect(201);

    expect(posted.body.data.pendingModeration).toBe(false);

    // 作者视角应看到 material 与 shade 两条待确认建议（condition/has_backrest 已有值不识别）
    const list = await request(app)
      .get(`/spots/${spotUuid}/suggestions`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .expect(200);

    const pending = list.body.data.items.filter((item: { status: string }) => item.status === "pending");
    const keys = pending.map((item: { fieldKey: string }) => item.fieldKey).sort();
    expect(keys).toEqual(["material", "shade"]);

    const shade = pending.find((item: { fieldKey: string }) => item.fieldKey === "shade");
    expect(shade.proposedValue).toBe("none");
    expect(shade.evidence.length).toBeGreaterThan(0);
  });

  it("同一字段的新评论只追加 evidence，不产生第二条 pending", async () => {
    const spotUuid = await publishBench(`去重长椅${suffix.slice(-4)}`, {
      has_backrest: true,
      condition: "good",
    });

    await request(app)
      .post(`/api/v1/spots/${spotUuid}/comments`)
      .set("Authorization", `Bearer ${commenterToken}`)
      .send({ body: "原来是木头的" })
      .expect(201);
    await request(app)
      .post(`/api/v1/spots/${spotUuid}/comments`)
      .set("Authorization", `Bearer ${commenterToken}`)
      .send({ body: "木质长椅，坐着还行" })
      .expect(201);

    const list = await request(app)
      .get(`/spots/${spotUuid}/suggestions`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .expect(200);

    const material = list.body.data.items.filter(
      (item: { fieldKey: string; status: string }) => item.fieldKey === "material" && item.status === "pending",
    );
    expect(material).toHaveLength(1);
    expect(material[0].evidence.length).toBe(2);
  });

  it("作者采纳后写回属性、产生修订快照、评论者收到通知", async () => {
    const spotUuid = await publishBench(`采纳测试长椅${suffix.slice(-4)}`, {
      has_backrest: true,
      condition: "good",
    });

    await request(app)
      .post(`/api/v1/spots/${spotUuid}/comments`)
      .set("Authorization", `Bearer ${commenterToken}`)
      .send({ body: "这个长椅有靠背吗？哦有靠背。另外可以坐 3 个人" })
      .expect(201);

    const before = await request(app)
      .get(`/spots/${spotUuid}/suggestions`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .expect(200);
    const countSuggestion = before.body.data.items.find(
      (item: { fieldKey: string; status: string }) => item.fieldKey === "count" && item.status === "pending",
    );
    expect(countSuggestion).toBeDefined();

    const accepted = await request(app)
      .post(`/suggestions/${countSuggestion.id}/accept`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .expect(200);

    expect(accepted.body.data.status).toBe("accepted");
    expect(accepted.body.data.attributes).toEqual({ count: 3 });
    expect(accepted.body.data.revisionNo).toBeGreaterThanOrEqual(2);

    const detail = await request(app).get(`/api/v1/spots/${spotUuid}`).expect(200);
    expect(detail.body.data.attributes.count).toBe(3);

    const revisions = await request(app)
      .get(`/api/v1/spots/${spotUuid}/revisions`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .expect(200);
    const latest = revisions.body.data.items[0];
    expect(latest.snapshot.source.type).toBe("comment_suggestion");

    const notifications = await request(app)
      .get("/api/v1/notifications")
      .set("Authorization", `Bearer ${commenterToken}`)
      .expect(200);
    expect(
      notifications.body.data.items.some((item: { type: string }) => item.type === "field_suggestion_accepted"),
    ).toBe(true);
  });

  it("非作者不能采纳；已采纳的建议不能重复处理", async () => {
    const spotUuid = await publishBench(`权限长椅${suffix.slice(-4)}`, {
      has_backrest: true,
      condition: "good",
    });

    await request(app)
      .post(`/api/v1/spots/${spotUuid}/comments`)
      .set("Authorization", `Bearer ${commenterToken}`)
      .send({ body: "原来是木头做的椅子" })
      .expect(201);

    const list = await request(app)
      .get(`/spots/${spotUuid}/suggestions`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .expect(200);
    const suggestion = list.body.data.items.find(
      (item: { fieldKey: string; status: string }) => item.status === "pending",
    );
    expect(suggestion).toBeDefined();

    await request(app)
      .post(`/suggestions/${suggestion.id}/accept`)
      .set("Authorization", `Bearer ${commenterToken}`)
      .expect(403);

    await request(app)
      .post(`/suggestions/${suggestion.id}/accept`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .expect(200);

    const again = await request(app)
      .post(`/suggestions/${suggestion.id}/dismiss`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .expect(409);
    expect(again.body.error.code).toBe("SUGGESTION_NOT_PENDING");
  });

  it("忽略时可附理由，评论者收到带理由的通知", async () => {
    const spotUuid = await publishBench(`忽略测试长椅${suffix.slice(-4)}`, {
      has_backrest: true,
      condition: "good",
    });

    await request(app)
      .post(`/api/v1/spots/${spotUuid}/comments`)
      .set("Authorization", `Bearer ${commenterToken}`)
      .send({ body: "感觉是塑料的椅子" })
      .expect(201);

    const list = await request(app)
      .get(`/spots/${spotUuid}/suggestions`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .expect(200);
    const suggestion = list.body.data.items.find(
      (item: { fieldKey: string; status: string }) => item.fieldKey === "material",
    );
    expect(suggestion).toBeDefined();

    await request(app)
      .post(`/suggestions/${suggestion.id}/dismiss`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ reason: "实地确认是金属，不是塑料" })
      .expect(200);

    const detail = await request(app)
      .get(`/spots/${spotUuid}/suggestions`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .expect(200);
    const dismissed = detail.body.data.items.find(
      (item: { id: string }) => item.id === suggestion.id,
    );
    expect(dismissed.status).toBe("dismissed");

    const notifications = await request(app)
      .get("/api/v1/notifications")
      .set("Authorization", `Bearer ${commenterToken}`)
      .expect(200);
    const note = notifications.body.data.items.find(
      (item: { type: string }) => item.type === "field_suggestion_dismissed",
    );
    expect(note).toBeDefined();
    expect(note.body).toContain("实地确认是金属");
  });

  it("评论被隐藏后，其待处理建议自动过期", async () => {
    const spotUuid = await publishBench(`过期测试长椅${suffix.slice(-4)}`, {
      has_backrest: true,
      condition: "good",
    });

    const comment = await request(app)
      .post(`/api/v1/spots/${spotUuid}/comments`)
      .set("Authorization", `Bearer ${commenterToken}`)
      .send({ body: "这椅子坏了吧，钉子都露出来了。而且这位置很晒，没树荫" })
      .expect(201);
    const commentId = comment.body.data.id as string;

    const before = await request(app)
      .get(`/spots/${spotUuid}/suggestions`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .expect(200);
    expect(
      before.body.data.items.some((item: { fieldKey: string; status: string }) => item.status === "pending"),
    ).toBe(true);

    await request(app)
      .post(`/api/v1/moderation/comments/${commentId}/hide`)
      .set("Authorization", `Bearer ${moderatorToken}`)
      .send({ reason: "测试隐藏" })
      .expect(200);

    const after = await request(app)
      .get(`/spots/${spotUuid}/suggestions`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .expect(200);
    expect(
      after.body.data.items.every((item: { status: string }) => item.status !== "pending"),
    ).toBe(true);
    expect(
      after.body.data.items.some((item: { status: string }) => item.status === "expired"),
    ).toBe(true);
  });

  it("作者本人在自己条目下的评论不产生建议；游客看不到未采纳建议", async () => {
    const spotUuid = await publishBench(`自评长椅${suffix.slice(-4)}`, {
      has_backrest: true,
      condition: "good",
    });

    await request(app)
      .post(`/api/v1/spots/${spotUuid}/comments`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ body: "我这个是木头长椅" })
      .expect(201);

    const ownerView = await request(app)
      .get(`/spots/${spotUuid}/suggestions`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .expect(200);
    expect(ownerView.body.data.items).toHaveLength(0);

    // 游客（不带 token）只应看到 accepted，当前没有任何 accepted
    const publicView = await request(app).get(`/spots/${spotUuid}/suggestions`).expect(200);
    expect(publicView.body.data.items).toHaveLength(0);
  });
});
