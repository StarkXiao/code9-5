import { describe, expect, it } from "vitest";
import { extractFieldSuggestions } from "../../src/services/moderation/fieldExtractor";
import type { AttributeSchema } from "../../src/modules/categories/schemaValidator";

// 用与 seed 一致的精简 Schema 覆盖五种分类的代表性字段
const benchSchema: AttributeSchema = {
  type: "object",
  required: ["has_backrest", "condition"],
  properties: {
    has_backrest: { type: "boolean", label: "是否有靠背" },
    count: { type: "integer", label: "可坐人数", minimum: 1, maximum: 50, unit: "人" },
    condition: {
      type: "string",
      label: "完好程度",
      enum: ["good", "fair", "poor"],
      enumLabels: { good: "完好", fair: "一般", poor: "破损" },
    },
    shade: {
      type: "string",
      label: "遮荫情况",
      enum: ["none", "partial", "full"],
      enumLabels: { none: "无遮荫", partial: "部分遮荫", full: "完全遮荫" },
    },
    material: {
      type: "string",
      label: "材质",
      enum: ["wood", "metal", "stone", "plastic"],
      enumLabels: { wood: "木质", metal: "金属", stone: "石材", plastic: "塑料" },
    },
    open_hours: { type: "string", label: "开放时段", maxLength: 40 },
  },
};

const drinkingSchema: AttributeSchema = {
  type: "object",
  required: ["type", "free"],
  properties: {
    type: {
      type: "string",
      label: "供水类型",
      enum: ["direct", "fountain", "station", "shop"],
      enumLabels: { direct: "直饮水龙头", fountain: "喷泉式饮水台", station: "供水站", shop: "附近商店代售" },
    },
    free: { type: "boolean", label: "是否免费" },
    closed_in_winter: { type: "boolean", label: "冬季会关闭" },
  },
};

const shelterSchema: AttributeSchema = {
  type: "object",
  required: ["capacity"],
  properties: {
    capacity: { type: "integer", label: "可容纳人数", minimum: 1, maximum: 200, unit: "人" },
    has_seats: { type: "boolean", label: "有座位" },
    coverage: {
      type: "string",
      label: "覆盖范围",
      enum: ["small", "medium", "large"],
      enumLabels: { small: "仅够几人", medium: "可站十几人", large: "可容纳很多人" },
    },
  },
};

const quietSchema: AttributeSchema = {
  type: "object",
  required: ["noise_level"],
  properties: {
    noise_level: {
      type: "string",
      label: "安静程度",
      enum: ["very_quiet", "quiet", "moderate"],
      enumLabels: { very_quiet: "非常安静", quiet: "比较安静", moderate: "一般" },
    },
    good_for: {
      type: "array",
      label: "适合做什么",
      items: {
        type: "string",
        enum: ["reading", "rest", "phone_call", "work"],
        enumLabels: { reading: "读书", rest: "发呆休息", phone_call: "打电话", work: "办公" },
      },
    },
  },
};

const lightSchema: AttributeSchema = {
  type: "object",
  required: ["brightness"],
  properties: {
    brightness: {
      type: "string",
      label: "亮度",
      enum: ["dim", "moderate", "bright"],
      enumLabels: { dim: "偏暗", moderate: "够用", bright: "很亮" },
    },
    coverage: {
      type: "string",
      label: "覆盖范围",
      enum: ["patchy", "partial", "comprehensive"],
      enumLabels: { patchy: "断断续续", partial: "大部分有", comprehensive: "全程覆盖" },
    },
    all_night: { type: "boolean", label: "整夜亮着" },
  },
};

describe("字段识别 - 布尔", () => {
  it("识别肯定表述", () => {
    const [hit] = extractFieldSuggestions("这个长椅有靠背，坐着很舒服", "bench", benchSchema, {});
    expect(hit).toMatchObject({ fieldKey: "has_backrest", value: true, valueLabel: "是" });
    expect(hit!.evidence).toContain("有靠背");
  });

  it("否定句不产生 true 建议", () => {
    const hits = extractFieldSuggestions("可惜没有靠背，坐久了累", "bench", benchSchema, {});
    expect(hits.find((h) => h.fieldKey === "has_backrest")).toBeUndefined();
  });

  it("前句否定、后句肯定时以后半句的肯定为准", () => {
    const [hit] = extractFieldSuggestions("旁边那个没有靠背，这个有靠背", "bench", benchSchema, {});
    expect(hit).toMatchObject({ fieldKey: "has_backrest", value: true });
  });

  it("免费 / 冬天关闭", () => {
    const hits = extractFieldSuggestions("直饮水是免费的，而且冬天会关", "drinking_water", drinkingSchema, {
      type: "direct",
    });
    expect(hits.map((h) => h.fieldKey).sort()).toEqual(["closed_in_winter", "free"]);
  });
});

describe("字段识别 - 枚举单选", () => {
  it("识别完好程度", () => {
    const [hit] = extractFieldSuggestions("椅子有点旧了，掉漆但还能坐", "bench", benchSchema, { has_backrest: true });
    expect(hit).toMatchObject({ fieldKey: "condition", value: "fair" });
  });

  it("识别遮荫（无遮荫）", () => {
    const [hit] = extractFieldSuggestions("正午很晒，没树荫", "bench", benchSchema, { has_backrest: true });
    expect(hit).toMatchObject({ fieldKey: "shade", value: "none" });
  });

  it("识别材质", () => {
    const [hit] = extractFieldSuggestions("原来是木头做的椅子", "bench", benchSchema, { has_backrest: true });
    expect(hit).toMatchObject({ fieldKey: "material", value: "wood" });
  });

  it("供水类型", () => {
    const [hit] = extractFieldSuggestions("旁边就是个供水站，可以带瓶子来打", "drinking_water", drinkingSchema, {
      free: true,
    });
    expect(hit).toMatchObject({ fieldKey: "type", value: "station" });
  });

  it("同名字段按分类消歧：雨棚 coverage 与照明 coverage 互不干扰", () => {
    const [shelterHit] = extractFieldSuggestions("棚子不大，只能站几个人", "rain_shelter", shelterSchema, {});
    expect(shelterHit).toMatchObject({ fieldKey: "coverage", value: "small" });

    const [lightHit] = extractFieldSuggestions("路灯断断续续，一段亮一段黑", "night_light", lightSchema, {});
    expect(lightHit).toMatchObject({ fieldKey: "coverage", value: "patchy" });
  });
});

describe("字段识别 - 整数", () => {
  it("识别阿拉伯数字 + 单位", () => {
    const [hit] = extractFieldSuggestions("这条长椅可以坐 3 个人", "bench", benchSchema, { has_backrest: true });
    expect(hit).toMatchObject({ fieldKey: "count", value: 3, valueLabel: "3 人" });
  });

  it("识别中文数字", () => {
    const hits = extractFieldSuggestions("棚子挺大，能躲十几人", "rain_shelter", shelterSchema, {});
    expect(hits.find((h) => h.fieldKey === "capacity")).toMatchObject({ fieldKey: "capacity", value: 10 });
  });

  it("超过上限的数字不识别", () => {
    const hits = extractFieldSuggestions("能坐 99 个人", "bench", benchSchema, { has_backrest: true });
    expect(hits.find((h) => h.fieldKey === "count")).toBeUndefined();
  });

  it("否定语境的数字不取", () => {
    const hits = extractFieldSuggestions("位置很小，站不了几个人，最多 2 人", "rain_shelter", shelterSchema, {});
    const hit = hits.find((h) => h.fieldKey === "capacity");
    expect(hit?.value).toBe(2);
  });
});

describe("字段识别 - 多选", () => {
  it("一条评论命中多个适合场景", () => {
    const hits = extractFieldSuggestions(
      "这里适合看书，也能打电话",
      "quiet_corner",
      quietSchema,
      {},
    );
    const hit = hits.find((h) => h.fieldKey === "good_for");
    expect(hit).toBeDefined();
    expect(hit!.value).toEqual(["reading", "phone_call"]);
    expect(hit!.valueLabel).toContain("读书");
  });
});

describe("字段识别 - 边界规则", () => {
  it("条目已有值的字段不产生建议（只补充不纠正）", () => {
    const hits = extractFieldSuggestions("这个椅子坏了，钉子都露出来了", "bench", benchSchema, {
      has_backrest: true,
      condition: "good",
    });
    expect(hits.find((h) => h.fieldKey === "condition")).toBeUndefined();
  });

  it("自由文本字段不识别", () => {
    const hits = extractFieldSuggestions("开放时段好像是早上六点", "drinking_water", drinkingSchema, {});
    expect(hits.find((h) => h.fieldKey === "open_hours")).toBeUndefined();
  });

  it("没有任何命中时返回空数组", () => {
    expect(extractFieldSuggestions("今天天气不错", "bench", benchSchema, {})).toEqual([]);
  });

  it("空数组也算无值，可以识别", () => {
    const [hit] = extractFieldSuggestions("适合办公", "quiet_corner", quietSchema, { good_for: [] });
    expect(hit).toMatchObject({ fieldKey: "good_for" });
  });

  it("多个命中按在原文中出现的顺序返回", () => {
    const hits = extractFieldSuggestions("木头椅子，很晒，坏了", "bench", benchSchema, { has_backrest: true });
    const keys = hits.map((h) => h.fieldKey);
    expect(keys).toEqual(["material", "shade", "condition"]);
  });

  it("照明亮度与整夜亮同时识别", () => {
    const hits = extractFieldSuggestions("这条路很亮，而且整夜都亮", "night_light", lightSchema, {});
    expect(hits.map((h) => h.fieldKey).sort()).toEqual(["all_night", "brightness"]);
  });
});
