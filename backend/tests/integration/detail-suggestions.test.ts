import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { createApp } from "../../src/app";
import { prisma } from "../../src/db/prisma";
import { initStorage } from "../../src/services/storage";

// 评论细节提取闭环（对应需求：从评论识别新细节 → 推给发布者确认 → 确认结果写回条目）：
// 1. 新用户的评论先审后发，通过审核时触发提取；
// 2. 可信用户的评论先发后审，发表时立即触发提取；
// 3. 发布者采纳建议后，建议值自动写入 spot.attributes；
// 4. 驳回建议不会改动条目，并通知评论作者；
// 5. 已填写字段不会被评论覆盖。
let app: Express;
let ownerToken = "";
let moderatorToken = "";
let newbieToken = "";
let trustedToken = "";
let ownerUuid = "";
let moderatorUuid = "";
let newbieUuid = "";
let trustedUuid = "";

const suffix = Date.now().toString(36);
const ownerEmail = `sugg-owner-${suffix}@example.com`;
const moderatorEmail = `sugg-mod-${suffix}@example.com`;
const newbieEmail = `sugg-newbie-${suffix}@example.com`;
const trustedEmail = `sugg-trusted-${suffix}@example.com`;
const password = "Str0ngPass1";

async function login(account: string): Promise<string> {
  const response = await request(app).post("/api/v1/auth/login").send({ account, password }).expect(200);
  return response.body.data.accessToken;
}

async function createAndPublishSpot(
  token: string,
  title: string,
  attributes: Record<string, unknown>,
  lat: number,
  lng: number,
): Promise<string> {
  const created = await request(app)
    .post("/api/v1/spots")
    .set("Authorization", `Bearer ${token}`)
    .send({
      categoryCode: "bench",
      title,
      description: "建议闭环集成测试",
      attributes,
      lat,
      lng,
      fuzzEnabled: false,
      mediaUuids: [],
    })
    .expect(201);

  const spotUuid = created.body.data.uuid as string;
  const submitted = await request(app)
    .post(`/api/v1/spots/${spotUuid}/submit`)
    .set("Authorization", `Bearer ${token}`)
    .expect(200);
  expect(submitted.body.data.status).toBe("pending");

  const taskId = submitted.body.data.taskId as string;
  await request(app)
    .post(`/api/v1/moderation/tasks/${taskId}/claim`)
    .set("Authorization", `Bearer ${moderatorToken}`)
    .expect(200);
  const approved = await request(app)
    .post(`/api/v1/moderation/tasks/${taskId}/approve`)
    .set("Authorization", `Bearer ${moderatorToken}`)
    .send({ reason: "信息完整" })
    .expect(200);
  expect(approved.body.data.status).toBe("published");

  return spotUuid;
}

beforeAll(async () => {
  await initStorage();
  app = createApp();

  for (const [email, nickname] of [
    [ownerEmail, `条目作者${suffix.slice(-4)}`],
    [moderatorEmail, `建议审核员${suffix.slice(-4)}`],
    [newbieEmail, `新用户${suffix.slice(-4)}`],
    [trustedEmail, `可信用户${suffix.slice(-4)}`],
  ] as const) {
    await request(app)
      .post("/api/v1/auth/register")
      .send({ email, password, nickname })
      .expect(201);
  }

  await prisma.user.update({ where: { email: moderatorEmail }, data: { role: "moderator" } });
  // 可信用户：信用分达标且已有 3 条通过的评论，评论走先发后审
  await prisma.user.update({ where: { email: trustedEmail }, data: { creditScore: 100, approvedCount: 3 } });

  ownerToken = await login(ownerEmail);
  moderatorToken = await login(moderatorEmail);
  newbieToken = await login(newbieEmail);
  trustedToken = await login(trustedEmail);

  const me = async (token: string) =>
    (await request(app).get("/api/v1/auth/me").set("Authorization", `Bearer ${token}`).expect(200)).body.data
      .user.uuid as string;
  ownerUuid = await me(ownerToken);
  moderatorUuid = await me(moderatorToken);
  newbieUuid = await me(newbieToken);
  trustedUuid = await me(trustedToken);
}, 120000);

afterAll(async () => {
  const userUuids = [ownerUuid, moderatorUuid, newbieUuid, trustedUuid].filter(Boolean);
  const users = await prisma.user.findMany({ where: { uuid: { in: userUuids } }, select: { id: true } });
  const ids = users.map((user) => user.id);

  if (ids.length > 0) {
    await prisma.comment.deleteMany({ where: { userId: { in: ids } } });
    await prisma.report.deleteMany({ where: { reporterId: { in: ids } } });
    await prisma.spotSuggestion.deleteMany({ where: { sourceUserId: { in: ids } } });
    await prisma.spot.deleteMany({ where: { ownerId: { in: ids } } });
    await prisma.mediaAsset.deleteMany({ where: { ownerId: { in: ids } } });
    await prisma.user.deleteMany({ where: { id: { in: ids } } });
  }

  await prisma.$disconnect();
}, 60000);

describe("评论细节提取 → 发布者确认 → 写回条目", () => {
  it("新用户评论先审后发，通过审核后生成待确认建议并通知发布者", async () => {
    // 必填字段先填齐，材质故意留空，留给评论补充
    const spotUuid = await createAndPublishSpot(
      ownerToken,
      `测试长椅A${suffix.slice(-4)}`,
      { has_backrest: true, condition: "good" },
      31.201,
      120.601,
    );

    const posted = await request(app)
      .post(`/api/v1/spots/${spotUuid}/comments`)
      .set("Authorization", `Bearer ${newbieToken}`)
      .send({ body: "补充一下，椅子是金属的，夏天有点烫" })
      .expect(201);
    expect(posted.body.data.pendingModeration).toBe(true);
    const commentId = posted.body.data.id as string;

    // 审核通过前提取尚未发生，发布者没有待确认项
    const before = await request(app)
      .get("/api/v1/me/suggestions?status=pending")
      .set("Authorization", `Bearer ${ownerToken}`)
      .expect(200);
    expect(before.body.data.items).toHaveLength(0);

    await request(app)
      .post(`/api/v1/moderation/comments/${commentId}/approve`)
      .set("Authorization", `Bearer ${moderatorToken}`)
      .expect(200);

    const mine = await request(app)
      .get("/api/v1/me/suggestions?status=pending")
      .set("Authorization", `Bearer ${ownerToken}`)
      .expect(200);

    const suggestion = mine.body.data.items.find(
      (item: { spotUuid: string }) => item.spotUuid === spotUuid,
    );
    expect(suggestion).toBeTruthy();
    expect(suggestion.fieldKey).toBe("material");
    expect(suggestion.proposedValue).toBe("metal");
    expect(suggestion.evidence).toContain("金属");

    // 发布者收到了站内通知
    const notifications = await request(app)
      .get("/api/v1/notifications")
      .set("Authorization", `Bearer ${ownerToken}`)
      .expect(200);
    expect(
      notifications.body.data.items.some((item: { type: string }) => item.type === "detail_suggestion"),
    ).toBe(true);

    // 其他用户看不到别人条目的待确认建议
    await request(app)
      .get(`/api/v1/spots/${spotUuid}/suggestions`)
      .set("Authorization", `Bearer ${newbieToken}`)
      .expect(403);

    // 条目作者在条目详情接口拿到建议列表
    const spotSuggestions = await request(app)
      .get(`/api/v1/spots/${spotUuid}/suggestions`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .expect(200);
    expect(spotSuggestions.body.data.items).toHaveLength(1);
  });

  it("发布者采纳建议后，值自动写回 spot.attributes，且评论作者收到采纳通知", async () => {
    const spotUuid = await createAndPublishSpot(
      ownerToken,
      `测试长椅B${suffix.slice(-4)}`,
      { has_backrest: true, condition: "good" },
      31.211,
      120.611,
    );

    const posted = await request(app)
      .post(`/api/v1/spots/${spotUuid}/comments`)
      .set("Authorization", `Bearer ${newbieToken}`)
      .send({ body: "这个是石头做的，夏天坐着凉快" })
      .expect(201);
    await request(app)
      .post(`/api/v1/moderation/comments/${posted.body.data.id}/approve`)
      .set("Authorization", `Bearer ${moderatorToken}`)
      .expect(200);

    const mine = await request(app)
      .get("/api/v1/me/suggestions?status=pending")
      .set("Authorization", `Bearer ${ownerToken}`)
      .expect(200);
    const suggestion = mine.body.data.items.find(
      (item: { spotUuid: string; fieldKey: string }) =>
        item.spotUuid === spotUuid && item.fieldKey === "material",
    );
    expect(suggestion).toBeTruthy();

    // 非作者不能采纳
    await request(app)
      .post(`/api/v1/suggestions/${suggestion.id}/accept`)
      .set("Authorization", `Bearer ${newbieToken}`)
      .expect(403);

    await request(app)
      .post(`/api/v1/suggestions/${suggestion.id}/accept`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .expect(200);

    const detail = await request(app).get(`/api/v1/spots/${spotUuid}`).expect(200);
    expect(detail.body.data.attributes.material).toBe("stone");

    // 建议已结案，待确认列表不再包含它
    const after = await request(app)
      .get("/api/v1/me/suggestions?status=pending")
      .set("Authorization", `Bearer ${ownerToken}`)
      .expect(200);
    expect(after.body.data.items.some((item: { id: string }) => item.id === suggestion.id)).toBe(false);

    // 评论作者可以在"我的补充"里看到采纳结果
    const contributed = await request(app)
      .get("/api/v1/me/suggestions/contributed")
      .set("Authorization", `Bearer ${newbieToken}`)
      .expect(200);
    const record = contributed.body.data.items.find(
      (item: { id: string }) => item.id === suggestion.id,
    );
    expect(record.status).toBe("accepted");

    const notifications = await request(app)
      .get("/api/v1/notifications")
      .set("Authorization", `Bearer ${newbieToken}`)
      .expect(200);
    expect(
      notifications.body.data.items.some((item: { type: string }) => item.type === "detail_accepted"),
    ).toBe(true);
  });

  it("发布者驳回建议不会改动条目，填写理由后通知评论作者", async () => {
    const spotUuid = await createAndPublishSpot(
      ownerToken,
      `测试长椅C${suffix.slice(-4)}`,
      { has_backrest: true, condition: "good" },
      31.221,
      120.621,
    );

    const posted = await request(app)
      .post(`/api/v1/spots/${spotUuid}/comments`)
      .set("Authorization", `Bearer ${newbieToken}`)
      .send({ body: "看着像木头，其实是塑料的" })
      .expect(201);
    await request(app)
      .post(`/api/v1/moderation/comments/${posted.body.data.id}/approve`)
      .set("Authorization", `Bearer ${moderatorToken}`)
      .expect(200);

    const mine = await request(app)
      .get("/api/v1/me/suggestions?status=pending")
      .set("Authorization", `Bearer ${ownerToken}`)
      .expect(200);
    const suggestion = mine.body.data.items.find(
      (item: { spotUuid: string }) => item.spotUuid === spotUuid,
    );
    expect(suggestion.fieldKey).toBe("material");
    expect(suggestion.proposedValue).toBe("plastic");

    await request(app)
      .post(`/api/v1/suggestions/${suggestion.id}/reject`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ reason: "现场核实为金属，情况不符" })
      .expect(200);

    const detail = await request(app).get(`/api/v1/spots/${spotUuid}`).expect(200);
    expect(detail.body.data.attributes.material).toBeUndefined();

    const notifications = await request(app)
      .get("/api/v1/notifications")
      .set("Authorization", `Bearer ${newbieToken}`)
      .expect(200);
    const rejectedNotice = notifications.body.data.items.find(
      (item: { type: string }) => item.type === "detail_rejected",
    );
    expect(rejectedNotice).toBeTruthy();
    expect(rejectedNotice.body).toContain("现场核实为金属");

    // 已结案的建议不能重复处理
    await request(app)
      .post(`/api/v1/suggestions/${suggestion.id}/accept`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .expect(422);
  });

  it("可信用户评论即时公开并立即提取；条目已填字段不会被评论覆盖", async () => {
    const spotUuid = await createAndPublishSpot(
      ownerToken,
      `测试长椅D${suffix.slice(-4)}`,
      { has_backrest: true, condition: "good", material: "metal" },
      31.231,
      120.631,
    );

    // material 作者已填（metal），评论说石头不应产生 material 建议；
    // wheelchair_space 未填，应产生建议
    const posted = await request(app)
      .post(`/api/v1/spots/${spotUuid}/comments`)
      .set("Authorization", `Bearer ${trustedToken}`)
      .send({ body: "这明明是石头的吧，而且轮椅可以停靠在旁边" })
      .expect(201);
    expect(posted.body.data.pendingModeration).toBe(false);

    const spotSuggestions = await request(app)
      .get(`/api/v1/spots/${spotUuid}/suggestions`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .expect(200);

    const keys = spotSuggestions.body.data.items.map((item: { fieldKey: string }) => item.fieldKey);
    expect(keys).toContain("wheelchair_space");
    expect(keys).not.toContain("material");

    const wheel = spotSuggestions.body.data.items.find(
      (item: { fieldKey: string }) => item.fieldKey === "wheelchair_space",
    );
    expect(wheel.proposedValue).toBe(true);
  });

  it("同一字段的重复补充累加支持数，矛盾建议不重复建单", async () => {
    const spotUuid = await createAndPublishSpot(
      ownerToken,
      `测试长椅E${suffix.slice(-4)}`,
      { has_backrest: true, condition: "good" },
      31.241,
      120.641,
    );

    // 两位用户都说"石头的"
    for (const token of [newbieToken, trustedToken]) {
      const posted = await request(app)
        .post(`/api/v1/spots/${spotUuid}/comments`)
        .set("Authorization", `Bearer ${token}`)
        .send({ body: "石头做的，挺结实" })
        .expect(201);
      if (posted.body.data.pendingModeration) {
        await request(app)
          .post(`/api/v1/moderation/comments/${posted.body.data.id}/approve`)
          .set("Authorization", `Bearer ${moderatorToken}`)
          .expect(200);
      }
    }

    const mine = await request(app)
      .get("/api/v1/me/suggestions?status=pending")
      .set("Authorization", `Bearer ${ownerToken}`)
      .expect(200);
    const materialSuggestions = mine.body.data.items.filter(
      (item: { spotUuid: string; fieldKey: string }) =>
        item.spotUuid === spotUuid && item.fieldKey === "material",
    );
    expect(materialSuggestions).toHaveLength(1);
    expect(materialSuggestions[0].supportCount).toBe(2);
  });
});
