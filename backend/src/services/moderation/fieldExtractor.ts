/**
 * 评论细节字段识别（F11）
 *
 * 输入：一条评论文本 + 条目分类的当前属性 Schema + 条目现有属性。
 * 输出：评论里明确断言、且条目尚无值的结构化字段建议。
 *
 * 设计原则：
 * - **纯函数、确定性**：不调模型、不联网，任何机器结果一致，方便单测与解释；
 * - **宁缺毋滥**：只识别词表覆盖、语义明确的断言，否定句优先判否，绝不猜测；
 * - **只补充不纠正**：条目已有值的字段不产出建议（纠正走"过期上报"通道）；
 * - **只识别有界取值**：布尔 / 枚举单选 / 整数 / 枚举多选；自由文本不识别。
 */
import type { AttributeProperty, AttributeSchema } from "../../modules/categories/schemaValidator";

export interface ExtractedField {
  fieldKey: string;
  fieldLabel: string;
  fieldType: "boolean" | "string" | "integer" | "array";
  value: boolean | string | number | string[];
  valueLabel: string;
  /** 评论中的命中原句片段 */
  evidence: string;
  /** 命中的关键词/取值文案，便于审计与解释 */
  matchedTerm: string;
}

// ------------------------------------------------------------------ 中文词表
//
// 按内置五个分类的字段键配置。键与 seed 中的属性键一一对应；
// 管理员自定义的新字段走通用兜底（见 generic*），识别不到就跳过。

type OptionTerms = Array<{ value: string; label: string; terms: string[] }>;

interface FieldHints {
  /** 判定为 true 的短语（先做否定检测，再做肯定匹配） */
  positive?: string[];
  /** 枚举值 → 触发词（触发词应包含 enumLabels 的中文文案） */
  options?: OptionTerms;
  /** 数字 + 量词，量词用于确认数字确实在描述这个字段 */
  units?: string[];
  /** 整数取值的额外约束（缺省取 schema 的 minimum/maximum） */
  min?: number;
  max?: number;
}

const HINTS: Record<string, FieldHints> = {
  // ---- 长椅 ----
  has_backrest: {
    positive: ["有靠背", "带靠背", "靠背椅", "有椅背", "能靠着", "可以靠", "靠着休息"],
  },
  wheelchair_space: {
    positive: ["轮椅可", "轮椅能", "轮椅可以", "方便轮椅", "轮椅通行", "无障碍"],
  },
  count: { units: ["人坐", "人位", "个人", "人", "个座", "个位置"], min: 1, max: 50 },
  condition: {
    options: [
      { value: "good", label: "完好", terms: ["很新", "完好", "保养得好", "没有破损", "没破损", "挺结实"] },
      {
        value: "fair",
        label: "一般",
        terms: ["有点旧", "旧了点", "一般般", "还算结实", "掉漆", "磨损"],
      },
      { value: "poor", label: "破损", terms: ["坏了", "破了", "烂了", "断裂", "缺了一块", "没法坐", "坐不了", "钉子", "摇晃"] },
    ],
  },
  shade: {
    options: [
      { value: "full", label: "完全遮荫", terms: ["树荫很密", "全是树荫", "完全遮荫", "遮阳很好", "很阴凉", "晒不到", "淋不到"] },
      { value: "partial", label: "部分遮荫", terms: ["有点树荫", "一半树荫", "部分遮荫", "有点遮阳", "有点晒"] },
      { value: "none", label: "无遮荫", terms: ["没有树荫", "没树荫", "无遮荫", "晒得很", "很晒", "暴晒", "太阳直晒"] },
    ],
  },
  material: {
    options: [
      { value: "wood", label: "木质", terms: ["木头", "木质", "木制", "木板", "木椅"] },
      { value: "metal", label: "金属", terms: ["金属", "铁制", "铁的", "钢制", "不锈钢", "铁艺"] },
      { value: "stone", label: "石材", terms: ["石头", "石材", "石凳", "石椅", "大理石", "花岗岩", "水泥"] },
      { value: "plastic", label: "塑料", terms: ["塑料"] },
    ],
  },

  // ---- 饮水处 ----
  free: {
    positive: ["免费", "不要钱", "不收费", "不用钱", "白嫖"],
  },
  closed_in_winter: {
    positive: ["冬天会关", "冬季关闭", "冬天关闭", "冬天没水", "冬天用不了", "冬天就停", "过冬会关"],
  },
  type: {
    options: [
      { value: "direct", label: "直饮水龙头", terms: ["直饮水", "直接喝", "可以直饮", "饮用水龙头", "直饮龙头"] },
      { value: "fountain", label: "喷泉式饮水台", terms: ["喷泉式", "饮水台", "按压喷水", "喷起来喝", "饮水喷泉"] },
      { value: "station", label: "供水站", terms: ["供水站", "打水站", "取水站", "净水站", "直饮站"] },
      { value: "shop", label: "附近商店代售", terms: ["小卖部买", "便利店买", "商店买水", "旁边店", "店里买"] },
    ],
  },
  height: {
    options: [
      { value: "low", label: "低（儿童/轮椅可用）", terms: ["很矮", "高度很低", "小孩够得到", "孩子能喝", "轮椅够得到", "轮椅能喝"] },
      { value: "high", label: "偏高", terms: ["有点高", "偏高", "个子矮够不到"] },
      { value: "multi", label: "多种高度", terms: ["高低都有", "好几个高度", "大人小孩都有", "两种高度"] },
    ],
  },
  temperature: {
    options: [
      { value: "warm", label: "温水", terms: ["温水", "热的", "热水", "温的"] },
      { value: "cold", label: "凉水", terms: ["冰水", "很凉", "凉水", "冰的"] },
      { value: "room", label: "常温", terms: ["常温", "不冰", "不凉不热"] },
    ],
  },

  // ---- 遮雨棚 ----
  capacity: { units: ["个人", "人躲", "人站", "人避雨", "个人躲雨", "人", "个"], min: 1, max: 200 },
  has_seats: {
    positive: ["有座", "有座位", "有椅子", "有凳子", "能坐着", "可以坐", "里面有凳", "带座位"],
  },
  enclosed: {
    positive: ["封闭的", "全封闭", "是封闭", "有围墙", "三面围", "带门的", "围起来的", "挡风的"],
  },
  lighting: {
    positive: ["有灯", "带灯", "有照明", "装了灯", "晚上有灯", "夜里有灯", "有路灯照到"],
  },

  // ---- 安静角落 ----
  noise_level: {
    options: [
      { value: "very_quiet", label: "非常安静", terms: ["非常安静", "特别安静", "很安静", "超级安静", "安静得", "一点不吵", "几乎没声音"] },
      { value: "quiet", label: "比较安静", terms: ["比较安静", "挺安静", "还算安静", "不吵", "挺清静", "比较清静"] },
      { value: "moderate", label: "一般", terms: ["有点吵", "不算安静", "声音不小", "挺吵", "比较吵", "有点闹"] },
    ],
  },
  best_time: {
    options: [
      { value: "morning", label: "清晨", terms: ["早上最安静", "清晨最安静", "上午安静", "早上人少", "清晨人少"] },
      { value: "noon", label: "中午", terms: ["中午安静", "午间安静", "午饭时安静"] },
      { value: "afternoon", label: "下午", terms: ["下午安静", "午后安静"] },
      { value: "evening", label: "傍晚", terms: ["傍晚安静", "黄昏安静"] },
      { value: "night", label: "夜间", terms: ["晚上安静", "夜里安静", "夜间安静", "深夜安静"] },
      { value: "all_day", label: "全天都安静", terms: ["全天都安静", "整天都安静", "什么时候都安静", "一天到晚都安静", "一直都安静"] },
    ],
  },
  crowd_level: {
    options: [
      { value: "empty", label: "基本没人", terms: ["基本没人", "几乎没人", "没什么人", "空荡荡", "没人去"] },
      { value: "sparse", label: "偶尔有人", terms: ["偶尔有人", "人很少", "零星几个人", "没几个人"] },
      { value: "moderate", label: "人不多不少", terms: ["人不多不少", "人还行", "人流量一般"] },
      { value: "crowded", label: "人比较多", terms: ["人很多", "人挺多", "人比较多", "挤满", "人山人海", "人满为患"] },
    ],
  },
  good_for: {
    options: [
      { value: "reading", label: "读书", terms: ["适合看书", "适合读书", "可以看书", "看书很好", "阅读"] },
      { value: "rest", label: "发呆休息", terms: ["适合发呆", "可以发呆", "适合休息", "放松", "小憩"] },
      { value: "phone_call", label: "打电话", terms: ["适合打电话", "可以打电话", "能打电话", "打电话很合适", "打电话", "通话"] },
      { value: "work", label: "办公", terms: ["适合办公", "可以办公", "能用电脑", "带电脑", "写东西"] },
    ],
  },

  // ---- 夜间照明 ----
  all_night: {
    positive: ["整夜都亮", "整夜亮", "一整晚都亮", "通宵亮", "整晚有灯", "夜里一直亮", "整夜有光"],
  },
  has_camera: {
    positive: ["有监控", "有摄像头", "装了监控", "有监视器", "监控摄像头", "看到监控"],
  },
  safety_rating: {
    // 安全感评分是主观分，评论里难以稳定识别，刻意不配词——识别错了比没有更糟
  },
  brightness: {
    options: [
      { value: "bright", label: "很亮", terms: ["很亮", "特别亮", "非常亮", "亮得很", "灯火通明", "很明亮", "照得很清楚"] },
      { value: "moderate", label: "够用", terms: ["亮度够用", "亮度还行", "还算亮", "基本够亮", "看得清路"] },
      { value: "dim", label: "偏暗", terms: ["很暗", "有点暗", "偏暗", "不够亮", "黑漆漆", "黑黢黢", "看不清路", "光线不足"] },
    ],
  },
  light_type: {
    options: [
      { value: "led", label: "LED", terms: ["LED", "led", "Led", "节能灯"] },
      { value: "halogen", label: "传统灯", terms: ["白炽灯", "卤素", "黄光灯泡", "老式灯泡", "钠灯", "水银灯"] },
      { value: "solar", label: "太阳能灯", terms: ["太阳能"] },
    ],
  },
};

// rain_shelter.coverage 与 night_light.coverage 是不同枚举，
// 需要按"分类.字段"消歧；单字段键的 HINTS 作为回退。
const RAIN_SHELTER_COVERAGE_HINTS: FieldHints = {
  options: [
    { value: "large", label: "可容纳很多人", terms: ["很大", "特别大", "能容纳很多", "好多人", "几十人", "站很多人", "面积很大"] },
    { value: "medium", label: "可站十几人", terms: ["十几人", "十来个人", "十几个", "不小"] },
    { value: "small", label: "仅够几人", terms: ["很小", "只能站几个", "几个人", "挤不下", "站不了几个人", "不大"] },
  ],
};

const SCOPED_HINTS: Record<string, FieldHints> = {
  "rain_shelter.coverage": RAIN_SHELTER_COVERAGE_HINTS,
  "night_light.coverage": {
    options: [
      { value: "comprehensive", label: "全程覆盖", terms: ["全程都有灯", "一路都亮", "整条路都有灯", "全覆盖", "没有暗段", "沿途都有灯"] },
      { value: "partial", label: "大部分有", terms: ["大部分有灯", "大部分路段", "基本都有灯", "多数地方有灯"] },
      { value: "patchy", label: "断断续续", terms: ["断断续续", "一段亮一段黑", "有的地方有灯", "隔一段才有", "灯间距很大", "有几段很黑"] },
    ],
  },
};

// 布尔字段的否定前缀：命中肯定短语时，先看它前面紧挨着的一两个字是否出现否定。
// 窗口不能开太大——"旁边那个没有靠背，这个有靠背"里后半句是肯定，
// 但与前半句的"没"相隔仍在 6 字内，大窗口会把真正的肯定误判成否定。
// 因此只看紧邻 3 字，足以覆盖"没有/不是/并无"这类搭配，又不会串句。
const NEGATION_TERMS = ["不", "没", "无", "非", "别", "未"];
const NEGATION_WINDOW = 3;

// 整数识别用的中文数字（只覆盖评论里常见的个位数与十，复杂读法不猜）
const CN_DIGITS: Record<string, number> = {
  零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9,
};

function hintsFor(categoryCode: string, fieldKey: string): FieldHints | undefined {
  return SCOPED_HINTS[`${categoryCode}.${fieldKey}`] ?? HINTS[fieldKey];
}

function isNegated(text: string, hitIndex: number): boolean {
  const before = text.slice(Math.max(0, hitIndex - NEGATION_WINDOW), hitIndex);
  return NEGATION_TERMS.some((term) => before.includes(term));
}

/** 截取命中词周围的原句片段，作为给作者看的 evidence */
function snippetAround(text: string, index: number, length: number, radius = 24): string {
  const start = Math.max(0, index - radius);
  const end = Math.min(text.length, index + length + radius);
  const prefix = start > 0 ? "…" : "";
  const suffix = end < text.length ? "…" : "";
  return `${prefix}${text.slice(start, end).replace(/\s+/g, " ").trim()}${suffix}`;
}

function findBoolean(text: string, hints: FieldHints | undefined): Omit<ExtractedField, "fieldKey" | "fieldLabel" | "fieldType"> | null {
  if (!hints?.positive) return null;
  for (const term of hints.positive) {
    // 同一句话里可能先否定后肯定（"旁边那个没有靠背，这个有靠背"），
    // 要跳过被否定的命中，继续往后找肯定的那一处。
    let from = 0;
    while (from <= text.length) {
      const idx = text.indexOf(term, from);
      if (idx < 0) break;
      if (!isNegated(text, idx)) {
        return { value: true, valueLabel: "是", evidence: snippetAround(text, idx, term.length), matchedTerm: term };
      }
      from = idx + term.length;
    }
  }
  return null;
}

function findEnum(
  text: string,
  property: AttributeProperty,
  hints: FieldHints | undefined,
): Omit<ExtractedField, "fieldKey" | "fieldLabel" | "fieldType"> | null {
  const allowed = property.enum ?? [];
  if (allowed.length === 0) return null;

  // 词表显式配置优先；没有配置时用 enumLabels 的中文文案做通用兜底。
  // 长词优先，避免"没有树荫"被"有树荫"之类的子串抢先命中（词表已规避，这里再加一道保险）。
  const options: OptionTerms =
    hints?.options ??
    allowed.map((value) => ({
      value,
      label: property.enumLabels?.[value] ?? value,
      terms: property.enumLabels?.[value] ? [property.enumLabels![value]!] : [value],
    }));

  const candidates = options
    .filter((option) => allowed.includes(option.value))
    .flatMap((option) => option.terms.map((term) => ({ term, option })))
    .sort((a, b) => b.term.length - a.term.length);

  for (const { term, option } of candidates) {
    const idx = text.indexOf(term);
    if (idx >= 0) {
      return {
        value: option.value,
        valueLabel: property.enumLabels?.[option.value] ?? option.label,
        evidence: snippetAround(text, idx, term.length),
        matchedTerm: term,
      };
    }
  }
  return null;
}

function parseChineseNumber(raw: string): number | null {
  if (/^\d+$/.test(raw)) return Number(raw);
  if (raw === "十几") return 10; // 约数取保守下界，与 medium 的语义一致
  if (!/^[零一二两三四五六七八九十]+$/.test(raw)) return null;

  if (raw === "十") return 10;
  if (raw.includes("十")) {
    const [tensPart, onesPart] = raw.split("十");
    const tens = tensPart === "" ? 1 : CN_DIGITS[tensPart];
    const ones = onesPart === "" || onesPart === undefined ? 0 : CN_DIGITS[onesPart];
    if (tens === undefined || ones === undefined) return null;
    return tens * 10 + ones;
  }
  if (raw.length === 1) return CN_DIGITS[raw] ?? null;
  return null;
}

function findInteger(
  text: string,
  property: AttributeProperty,
  hints: FieldHints | undefined,
): Omit<ExtractedField, "fieldKey" | "fieldLabel" | "fieldType"> | null {
  const units = hints?.units ?? [];
  if (units.length === 0) return null;

  const min = hints?.min ?? property.minimum ?? 0;
  const max = hints?.max ?? property.maximum ?? Number.MAX_SAFE_INTEGER;

  // 量词按长度降序，保证"个人"优先于"人"
  const unitPattern = [...new Set(units)].sort((a, b) => b.length - a.length).join("|");
  const re = new RegExp(`(\\d+|[零一二两三四五六七八九十]{1,3}|十几)\\s*(${unitPattern})`, "g");

  const matches: Array<{ num: number; index: number; raw: string; unit: string }> = [];
  for (const match of text.matchAll(re)) {
    const num = parseChineseNumber(match[1]!);
    if (num !== null && num >= min && num <= max) {
      matches.push({ num, index: match.index ?? 0, raw: match[1]!, unit: match[2]! });
    }
  }
  if (matches.length === 0) return null;

  // 取最小的非零数字：评论里"能坐 4、5 个人"取保守值；但排除"1 个人都没有"这类否定
  const positive = matches.filter((m) => {
    const before = text.slice(Math.max(0, m.index - 3), m.index);
    return !/(没|不|无|超不过|不到)/.test(before);
  });
  const pool = positive.length > 0 ? positive : matches;
  const picked = pool.reduce((best, m) => (m.num < best.num ? m : best));

  return {
    value: picked.num,
    valueLabel: property.unit ? `${picked.num} ${property.unit}` : String(picked.num),
    evidence: snippetAround(text, picked.index, picked.raw.length + picked.unit.length),
    matchedTerm: `${picked.raw}${picked.unit}`,
  };
}

function findArrayEnum(
  text: string,
  property: AttributeProperty,
  hints: FieldHints | undefined,
): Omit<ExtractedField, "fieldKey" | "fieldLabel" | "fieldType"> | null {
  const allowed = property.items?.enum ?? [];
  if (allowed.length === 0) return null;

  const options: OptionTerms =
    hints?.options ??
    allowed.map((value) => ({
      value,
      label: property.items?.enumLabels?.[value] ?? value,
      terms: property.items?.enumLabels?.[value] ? [property.items!.enumLabels![value]!] : [value],
    }));

  const picked: Array<{ value: string; label: string; term: string; index: number }> = [];
  for (const option of options) {
    if (!allowed.includes(option.value)) continue;
    // 一个选项有多个触发词（如"打电话/通话"），只要任一命中即可，取最先出现的那个
    let best: { term: string; index: number } | null = null;
    for (const term of option.terms) {
      const idx = text.indexOf(term);
      if (idx >= 0 && (best === null || idx < best.index)) {
        best = { term, index: idx };
      }
    }
    if (best) {
      picked.push({
        value: option.value,
        label: property.items?.enumLabels?.[option.value] ?? option.label,
        term: best.term,
        index: best.index,
      });
    }
  }
  if (picked.length === 0) return null;

  picked.sort((a, b) => a.index - b.index);
  const first = picked[0]!;
  return {
    value: picked.map((item) => item.value),
    valueLabel: picked.map((item) => item.label).join("、"),
    evidence: snippetAround(text, first.index, first.term.length),
    matchedTerm: picked.map((item) => item.term).join("、"),
  };
}

// ------------------------------------------------------------------ 主入口

/**
 * 从评论中提取字段建议。
 *
 * @param text 评论文本
 * @param categoryCode 条目分类 code（用于区分不同分类下同名字段的词表）
 * @param schema 该分类的当前属性 Schema
 * @param currentAttributes 条目当前属性；已有值（键存在且非空）的字段不产出建议
 */
export function extractFieldSuggestions(
  text: string,
  categoryCode: string,
  schema: AttributeSchema,
  currentAttributes: Record<string, unknown>,
): ExtractedField[] {
  const results: ExtractedField[] = [];

  for (const [fieldKey, property] of Object.entries(schema.properties ?? {})) {
    const current = currentAttributes[fieldKey];
    const hasValue =
      current !== undefined && current !== null && current !== "" && !(Array.isArray(current) && current.length === 0);
    if (hasValue) continue;

    const hints = hintsFor(categoryCode, fieldKey);
    const label = property.label ?? fieldKey;
    let hit: Omit<ExtractedField, "fieldKey" | "fieldLabel" | "fieldType"> | null = null;

    switch (property.type) {
      case "boolean":
        hit = findBoolean(text, hints);
        if (hit) results.push({ fieldKey, fieldLabel: label, fieldType: "boolean", ...hit });
        break;
      case "integer":
        hit = findInteger(text, property, hints);
        if (hit) results.push({ fieldKey, fieldLabel: label, fieldType: "integer", ...hit });
        break;
      case "string":
        hit = findEnum(text, property, hints);
        if (hit) results.push({ fieldKey, fieldLabel: label, fieldType: "string", ...hit });
        break;
      case "array":
        hit = findArrayEnum(text, property, hints);
        if (hit) results.push({ fieldKey, fieldLabel: label, fieldType: "array", ...hit });
        break;
      default:
        break;
    }
  }

  // 按评论中出现位置排序（evidence 已带 …，用 matchedTerm 在原文的位置更准）
  results.sort((a, b) => text.indexOf(a.matchedTerm) - text.indexOf(b.matchedTerm));
  return results;
}
