import { describe, expect, it } from "vitest";
import { chineseNumberToInt, extractDetailsFromText } from "../../src/services/detail-extraction";
import type { AttributeSchema } from "../../src/modules/categories/schemaValidator";

// 与种子数据里 bench 分类的 Schema 保持一致
const benchSchema: AttributeSchema = {
  type: "object",
  required: ["has_backrest", "condition"],
  properties: {
    has_backrest: { type: "boolean", label: "是否有靠背" },
    count: { type: "integer", label: "可坐人数", minimum: 1, maximum: 50 },
    condition: {
      type: "string",
      label: "完好程度",
      enum: ["good", "fair", "poor"],
    },
    shade: {
      type: "string",
      label: "遮荫情况",
      enum: ["none", "partial", "full"],
    },
    wheelchair_space: { type: "boolean", label: "轮椅可停靠" },
    material: {
      type: "string",
      label: "材质",
      enum: ["wood", "metal", "stone", "plastic", "mixed"],
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
    },
    best_time: {
      type: "string",
      label: "最安静的时段",
      enum: ["morning", "noon", "afternoon", "evening", "night", "all_day"],
    },
    good_for: {
      type: "array",
      label: "适合做什么",
      items: { type: "string", enum: ["reading", "rest", "phone_call", "work"] },
    },
  },
};

const waterSchema: AttributeSchema = {
  type: "object",
  required: ["type", "free"],
  properties: {
    type: {
      type: "string",
      label: "供水类型",
      enum: ["direct", "fountain", "station", "shop"],
    },
    free: { type: "boolean", label: "是否免费" },
    temperature: { type: "string", label: "水温", enum: ["cold", "room", "warm"] },
    closed_in_winter: { type: "boolean", label: "冬季会关闭" },
  },
};

const lightSchema: AttributeSchema = {
  type: "object",
  required: ["brightness"],
  properties: {
    brightness: { type: "string", label: "亮度", enum: ["dim", "moderate", "bright"] },
    all_night: { type: "boolean", label: "整夜亮着" },
    has_camera: { type: "boolean", label: "附近有监控" },
  },
};

function fieldMap(text: string, schema: AttributeSchema, attributes: Record<string, unknown> = {}) {
  const items = extractDetailsFromText(text, schema, attributes);
  return new Map(items.map((item) => [item.fieldKey, item]));
}

describe("评论细节提取", () => {
  it("识别肯定的布尔字段", () => {
    const result = fieldMap("这个长椅有靠背，坐着很舒服", benchSchema);
    expect(result.get("has_backrest")?.proposedValue).toBe(true);
  });

  it("就近否定词把布尔字段判为 false", () => {
    const result = fieldMap("可惜没有靠背，坐久了累", benchSchema);
    expect(result.get("has_backrest")?.proposedValue).toBe(false);
  });

  it("否定窗口跨句不生效，后面的肯定陈述正常提取", () => {
    const result = fieldMap("那边那张没有靠背。这张有靠背，推荐", benchSchema);
    expect(result.get("has_backrest")?.proposedValue).toBe(true);
  });

  it("'没几个/不多' 这类不以存在性反转处理", () => {
    // 不含任何规则关键词时应当无建议，而不是乱猜
    const result = fieldMap("今天人不多，风也不大", benchSchema);
    expect(result.size).toBe(0);
  });

  it("提取枚举字段并选择未被否定的枚举值", () => {
    const result = fieldMap("不是木头的，是金属椅子，夏天烫", benchSchema);
    expect(result.get("material")?.proposedValue).toBe("metal");
  });

  it("被否定的枚举值不会被采用", () => {
    const result = fieldMap("别看它像木头，其实是塑料的", benchSchema);
    expect(result.get("material")?.proposedValue).toBe("plastic");
  });

  it("遮荫否定：'一点阴凉都没有' 判为无遮荫", () => {
    const result = fieldMap("中午一点阴凉都没有，晒得很", benchSchema);
    expect(result.get("shade")?.proposedValue).toBe("none");
  });

  it("提取数量，支持阿拉伯数字", () => {
    const result = fieldMap("这个长椅能坐4个人没问题", benchSchema);
    expect(result.get("count")?.proposedValue).toBe(4);
  });

  it("提取数量，支持口语中文数字", () => {
    const result = fieldMap("大概三个人的位置", benchSchema);
    expect(result.get("count")?.proposedValue).toBe(3);
  });

  it("超出 Schema 范围的数量不产生建议", () => {
    const result = fieldMap("能坐 99 个人", benchSchema);
    expect(result.has("count")).toBe(false);
  });

  it("数组字段提取多个取值", () => {
    const result = fieldMap("适合看书，也适合打电话", quietSchema);
    const value = result.get("good_for")?.proposedValue;
    expect(value).toEqual(expect.arrayContaining(["reading", "phone_call"]));
  });

  it("安静程度与最佳时段可同时提取", () => {
    const result = fieldMap("这里早上最安静，特别适合发呆", quietSchema);
    expect(result.get("best_time")?.proposedValue).toBe("morning");
    expect(result.get("noise_level")?.proposedValue).toBe("very_quiet");
  });

  it("已填写字段不再提取（不覆盖作者数据）", () => {
    const result = fieldMap("这个长椅有靠背", benchSchema, { has_backrest: false });
    expect(result.has("has_backrest")).toBe(false);
  });

  it("每条建议都带评论原句作为证据", () => {
    const result = fieldMap("环境一般，椅子是石头的，夏天不烫。地面也平整。", benchSchema);
    const evidence = result.get("material")?.evidence ?? "";
    expect(evidence).toContain("石头");
    expect(evidence).not.toContain("地面");
  });

  it("没有任何关键词时返回空数组", () => {
    expect(extractDetailsFromText("今天天气不错", benchSchema, {})).toEqual([]);
  });

  it("未配置规则的 Schema 字段不产生建议", () => {
    const custom: AttributeSchema = {
      type: "object",
      properties: { custom_text: { type: "string", label: "自定义文本", maxLength: 40 } },
    };
    expect(extractDetailsFromText("有靠背", custom, {})).toEqual([]);
  });
});

describe("饮水处规则", () => {
  it("识别直饮 + 免费 + 凉水", () => {
    const result = fieldMap("这里是直饮水龙头，免费，水是凉的", waterSchema);
    expect(result.get("type")?.proposedValue).toBe("direct");
    expect(result.get("free")?.proposedValue).toBe(true);
    expect(result.get("temperature")?.proposedValue).toBe("cold");
  });

  it("'不是免费的' 正确判为收费", () => {
    const result = fieldMap("水不是免费的，投币才能接", waterSchema);
    expect(result.get("free")?.proposedValue).toBe(false);
  });

  it("冬天关闭的季节性提示", () => {
    const result = fieldMap("冬天会关，结冰用不了，夏天再来", waterSchema);
    expect(result.get("closed_in_winter")?.proposedValue).toBe(true);
  });
});

describe("夜间照明规则", () => {
  it("整夜亮、很亮、有监控三个字段", () => {
    const result = fieldMap("这一段整夜都亮，很亮，旁边有监控摄像头", lightSchema);
    expect(result.get("all_night")?.proposedValue).toBe(true);
    expect(result.get("brightness")?.proposedValue).toBe("bright");
    expect(result.get("has_camera")?.proposedValue).toBe(true);
  });

  it("'半夜就灭' 判为不整夜亮", () => {
    const result = fieldMap("灯十点就灭，半夜就灭了", lightSchema);
    expect(result.get("all_night")?.proposedValue).toBe(false);
  });

  it("'没监控' 判为无监控", () => {
    const result = fieldMap("这段路没监控，走夜路注意安全", lightSchema);
    expect(result.get("has_camera")?.proposedValue).toBe(false);
  });
});

describe("中文小数字解析", () => {
  it.each([
    ["三", 3],
    ["十", 10],
    ["十二", 12],
    ["二十", 20],
    ["二十三", 23],
    ["两", 2],
    ["4", 4],
  ])("%s => %i", (raw, expected) => {
    expect(chineseNumberToInt(raw)).toBe(expected);
  });
});
