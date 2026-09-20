/**
 * 评论细节提取引擎
 *
 * 输入：一条评论文本 + 条目所属分类的属性 Schema
 * 输出：若干"待补充字段"建议（字段 key、建议值、证据短句）
 *
 * 设计取舍：
 * - 不接外部 NLP / LLM 服务：项目的部署假设是单机 Docker，离线可用、结果可预期。
 *   规则全部声明在本文件里，规则能覆盖五个内置分类的全部布尔/枚举字段，
 *   管理员后续改 Schema 时，没配规则的新字段不会被乱猜（宁可不提取，不可提错）。
 * - 中文否定词必须就近判定，"这里没有靠背，但是有遮荫"不能把两个字段都判反。
 * - 每条建议必须带评论原句作为证据，发布者是最终把关人，看不到原话的建议不发。
 */
import type { AttributeProperty, AttributeSchema } from "../../modules/categories/schemaValidator";

export interface ExtractedSuggestion {
  fieldKey: string;
  fieldType: "boolean" | "string" | "integer" | "array";
  proposedValue: boolean | string | number | string[];
  evidence: string;
}

interface BooleanRule {
  kind: "boolean";
  /** 命中即认为该属性为 true 的关键词（不含否定修饰） */
  positive: string[];
  /** 命中即明确为 false 的短语，优先级高于通用否定词，如"没有靠背" */
  negative?: string[];
}

interface EnumRule {
  kind: "enum";
  /** value → 命中该枚举值的关键词 */
  values: Record<string, string[]>;
  /** value → 出现时表示"不是这个值"的短语，如"像木头"（比喻，不是真材质） */
  negated?: Record<string, string[]>;
}

interface IntegerRule {
  kind: "integer";
  /** 数量提示词，如"能坐 4 个人"里的"个人" */
  measures: string[];
}

interface ArrayRule {
  kind: "array";
  /** value → 关键词；提取到的值并入数组 */
  values: Record<string, string[]>;
}

type FieldRule = BooleanRule | EnumRule | IntegerRule | ArrayRule;

/**
 * 字段规则表。key 与各分类 Schema 的 properties key 对齐。
 * 多个分类共用同一字段（如 has_seats、coverage）时规则天然复用；
 * 取值集合不同的同名字段（coverage 在遮雨棚/夜间照明里枚举不同），
 * 匹配后还会再过一次"枚举值必须在 Schema 允许列表里"的校验。
 */
const FIELD_RULES: Record<string, FieldRule> = {
  // ---- 长椅 ----
  has_backrest: {
    kind: "boolean",
    positive: ["有靠背", "靠背很舒服", "带靠背", "带椅背", "有椅背"],
    negative: ["没靠背", "没有靠背", "无靠背", "不带靠背"],
  },
  wheelchair_space: {
    kind: "boolean",
    positive: ["轮椅可以", "轮椅能", "轮椅可停靠", "无障碍", "推车能停", "婴儿车能停"],
  },
  material: {
    kind: "enum",
    values: {
      wood: ["木头", "木质", "木板", "实木"],
      metal: ["金属", "铁艺", "钢制", "铁架"],
      stone: ["石头", "石材", "石凳", "大理石", "花岗岩"],
      plastic: ["塑料"],
      mixed: ["木铁", "混合材质"],
    },
    negated: {
      wood: ["像木头", "看着像木", "仿木"],
    },
  },
  condition: {
    kind: "enum",
    values: {
      good: ["很新", "完好", "保养得不错", "没有破损"],
      fair: ["有点旧", "旧了点", "掉漆", "一般般"],
      poor: ["破了", "破损", "坏了", "裂了", "塌了", "钉子翘", "螺丝松", "不能坐了"],
    },
  },
  shade: {
    kind: "enum",
    values: {
      full: ["很阴凉", "晒不到太阳", "完全遮阴", "完全遮荫", "树荫很密", "一直有阴凉", "阴凉很足"],
      partial: ["有点树荫", "部分遮阴", "部分遮荫", "一半晒", "有点遮阴", "有点遮荫"],
      none: ["没有树荫", "没树荫", "没遮阴", "没遮荫", "阴凉都没有", "遮阴都没有", "一点阴凉", "晒得很", "很晒", "直晒"],
    },
  },
  count: {
    kind: "integer",
    measures: ["个人", "人坐", "个位置", "个座位"],
  },

  // ---- 饮水处 ----
  free: {
    kind: "boolean",
    positive: ["免费", "不要钱", "不收费", "不收钱"],
    negative: ["不是免费", "不免费", "非免费", "要收费", "要收钱", "得花钱", "需要花钱"],
  },
  closed_in_winter: {
    kind: "boolean",
    positive: ["冬天关", "冬季关闭", "冬天会关", "冬天没水", "冬天停", "冻住", "结冰用不了"],
  },
  type: {
    kind: "enum",
    values: {
      direct: ["直饮水", "直接喝", "直饮龙头", "可以直接接水喝"],
      fountain: ["喷泉式", "饮水台", "喷起来", "按一下往上喷"],
      station: ["供水站", "取水站", "打水站", "售水机", "净水站"],
      shop: ["店里买", "商店", "便利店", "小卖部", "超市买"],
    },
  },
  height: {
    kind: "enum",
    values: {
      low: ["很矮", "高度低", "小孩够得到", "小朋友能接", "轮椅能接", "坐轮椅"],
      high: ["很高", "有点高", "够不太着", "个子矮够不到"],
      multi: ["高低都有", "好几个高度", "大人小孩都有", "两种高度"],
    },
  },
  temperature: {
    kind: "enum",
    values: {
      cold: ["凉水", "冰的", "冰爽", "很冷", "水是凉的"],
      warm: ["温水", "热的", "热水"],
      room: ["常温", "不凉不热"],
    },
  },

  // ---- 遮雨棚 ----
  has_seats: {
    kind: "boolean",
    positive: ["有座位", "有凳子", "有椅子", "能坐着躲雨", "带座位", "里面能坐"],
    negative: ["没有座位", "没座位", "没有凳子", "没凳子", "没有椅子", "不能坐"],
  },
  enclosed: {
    kind: "boolean",
    positive: ["是封闭", "全封闭", "有围墙", "有墙", "有门", "三面挡", "四面挡", "挡风", "封闭的"],
  },
  lighting: {
    kind: "boolean",
    positive: ["有灯", "装了灯", "有照明", "灯很亮"],
    negative: ["没有灯", "没灯", "没照明", "没有照明"],
  },
  coverage: {
    kind: "enum",
    // rain_shelter: small/medium/large；night_light: patchy/partial/comprehensive
    values: {
      large: ["很大", "能容纳很多人", "能站很多人", "一大片"],
      small: ["很小", "只能站几个人", "就一点点", "不大"],
      comprehensive: ["全程都有", "一整段都有", "整条路都有", "全覆盖"],
      partial: ["大部分有", "大部分路段", "基本都有灯"],
      patchy: ["断断续续", "一段有一段没有", "时有时无", "好几段黑的", "不太连续"],
    },
  },

  // ---- 安静角落 ----
  noise_level: {
    kind: "enum",
    values: {
      // 顺序敏感：匹配器按数组顺序扫描、取最靠后的命中位置，
      // 这里只放长短语，短词"安静"单独走 quiet，避免"最安静"被 quiet 的"安静"抢先
      very_quiet: ["特别安静", "非常安静", "很安静", "最安静", "好安静", "安静得很", "超级安静", "几乎没声音", "鸦雀无声"],
      quiet: ["比较安静", "挺安静", "还算安静", "很安静吗", "安静", "不吵"],
      moderate: ["有点吵", "一般般吵", "不算安静", "有些噪音", "有点噪音"],
    },
  },
  best_time: {
    kind: "enum",
    values: {
      morning: ["早上最", "清晨最", "上午最"],
      noon: ["中午最", "正午最"],
      afternoon: ["下午最"],
      evening: ["傍晚最", "晚上最", "夜里最", "夜间最"],
      night: ["深夜最", "半夜最"],
      all_day: ["全天都安静", "一天到晚都安静", "什么时候都安静", "一整天都安静"],
    },
  },
  crowd_level: {
    kind: "enum",
    values: {
      empty: ["基本没人", "几乎没人", "空无一人", "没人去"],
      sparse: ["偶尔有人", "人很少", "没什么人"],
      moderate: ["人不多不少", "人还行", "人流一般"],
      crowded: ["人很多", "很挤", "人满为患", "挤满了", "人特别多"],
    },
  },
  good_for: {
    kind: "array",
    values: {
      reading: ["适合看书", "能看书", "读书", "看书很合适"],
      rest: ["适合发呆", "适合休息", "闭目养神", "小憩"],
      phone_call: ["适合打电话", "打电话很合适", "接电话", "通话不吵"],
      work: ["适合办公", "能带电脑", "用电脑", "写东西", "改 PPT", "办公很合适"],
    },
  },

  // ---- 夜间照明 ----
  brightness: {
    kind: "enum",
    values: {
      bright: ["很亮", "特别亮", "亮堂堂", "照得很清楚"],
      moderate: ["亮度够用", "够亮", "看得清路"],
      dim: ["很暗", "偏暗", "有点暗", "光线昏暗", "不太亮", "昏黄"],
    },
  },
  light_type: {
    kind: "enum",
    values: {
      led: ["LED", "led", "Led"],
      halogen: ["白炽灯", "黄光灯泡", "老式灯泡", "钨丝灯", "卤素"],
      solar: ["太阳能", "光伏"],
    },
  },
  all_night: {
    kind: "boolean",
    positive: ["整夜都亮", "一整晚亮", "通宵亮", "整晚不灭", "夜里一直亮", "天亮才灭", "一整夜"],
    negative: ["不是整夜", "半夜就灭", "后半夜就灭", "十点就灭", "10点就灭", "会关灯"],
  },
  has_camera: {
    kind: "boolean",
    positive: ["有监控", "有摄像头", "装了探头", "电子眼", "监控摄像头"],
    negative: ["没有监控", "没监控", "没摄像头", "没有摄像头"],
  },
};

/**
 * 否定词只在关键词所在的**同一个分句**内、且距离不超过窗口字数时才算反转。
 * 分句边界（句号、问号、分号、换行）必须硬隔离，否则
 * "那边那张没有靠背。这张有靠背"会被前面的否定词污染。
 * 逗号在中文里可以连接转折复句（"不是 A，是 B"），不作为硬边界。
 */
const NEGATION_WINDOW = 8;
const HARD_DELIMITERS = /[。！？；\n.!?;]/;
// 必须按长度降序：否则 lastIndexOf("不") 会截获"不是"里的"不"，
// 之后的转折判定在"不是…是…"句子上就会失准
const NEGATORS = ["没有", "不是", "没", "不", "无", "未"];

/** "不多/不少/没几个"这类不是对存在性的否定，单独排除 */
const NEGATION_EXCEPTIONS = ["不多", "不少", "没几个", "没多久", "没多远"];

function findHardBoundaryBefore(text: string, index: number): number {
  for (let i = index - 1; i >= 0; i -= 1) {
    if (HARD_DELIMITERS.test(text[i]!)) return i + 1;
  }
  return 0;
}

function isNegatedNear(text: string, index: number): boolean {
  const segmentStart = findHardBoundaryBefore(text, index);
  // 窗口不能越过本句起点，否则"没有靠背。这张有靠背"会被上一句的否定词污染
  const windowStart = Math.max(segmentStart, index - NEGATION_WINDOW);
  const before = text.slice(windowStart, index);
  if (NEGATION_EXCEPTIONS.some((phrase) => before.endsWith(phrase))) return false;
  if (!NEGATORS.some((negator) => before.includes(negator))) return false;

  // 否定词与关键词之间若出现"是"，说明否定属于前一个并列项：
  // "不是木头的，是金属椅子"——"不"否定的是木头，与金属无关。
  // 转折连词"但/但是/可/可是/而/反而"同理："不是木头，倒像是金属"。
  const breakers = ["是", "但", "可", "而", "反而", "其实", "实际"];
  // 取所有否定词出现位置里**最靠近关键词**的那个，
  // 不能只看每类词的 lastIndexOf——"不是免费"里 lastIndexOf("不") 会越过"不是"的边界
  let nearestNegator = -1;
  for (let i = before.length - 1; i >= 0; i -= 1) {
    if (NEGATORS.some((negator) => before.startsWith(negator, i))) {
      nearestNegator = i;
      break;
    }
  }
  if (nearestNegator < 0) return false;
  if (breakers.some((breaker) => before.slice(nearestNegator).includes(breaker))) return false;

  return true;
}

/** 从评论里截取包含命中词的短句作为证据（按标点切分，去首尾空白） */
const EVIDENCE_MAX = 100;

function extractEvidence(text: string, matchStart: number, matchEnd: number): string {
  const delimiters = /[，。！？；、\n,.!?;~～]/;
  let start = matchStart;
  while (start > 0 && !delimiters.test(text[start - 1]!)) start -= 1;
  let end = matchEnd;
  while (end < text.length && !delimiters.test(text[end]!)) end += 1;

  const sentence = text.slice(start, end).trim();
  if (sentence.length <= EVIDENCE_MAX) return sentence;
  // 命中词尽量保留在片段里，超长时从命中位置向前截
  const head = Math.max(0, matchStart - (EVIDENCE_MAX - (matchEnd - matchStart)));
  return `${sentence.slice(head, head + EVIDENCE_MAX)}…`;
}

function findKeyword(text: string, keywords: string[]): { start: number; end: number } | null {
  for (const keyword of keywords) {
    const index = text.indexOf(keyword);
    if (index >= 0) return { start: index, end: index + keyword.length };
  }
  return null;
}

function findLastKeyword(text: string, keywords: string[]): { start: number; end: number } | null {
  let last: { start: number; end: number } | null = null;
  for (const keyword of keywords) {
    const index = text.lastIndexOf(keyword);
    if (index >= 0 && (!last || index > last.start)) {
      last = { start: index, end: index + keyword.length };
    }
  }
  return last;
}

function matchBoolean(
  text: string,
  key: string,
  property: AttributeProperty,
  rule: BooleanRule,
): ExtractedSuggestion | null {
  // 明确否定短语先定位，但同句/后文出现肯定陈述时（"原来没有靠背，现在装上了"），
  // 让肯定分支接管——所以这里只记录命中，最终决定权交给后面的肯定扫描
  const negativeHit = findLastKeyword(text, rule.negative ?? []);

  // 肯定关键词必须逐词检查：通用词（"靠背"）前可能带否定，
  // 但规则表已尽量让肯定词自带"有"（"有靠背"），命中后仍走一次就近否定兜底
  let positiveHit: { keyword: string; index: number } | null = null;
  for (const keyword of rule.positive) {
    // 同一关键词可能在否定句和肯定句各出现一次（"没有靠背。…有靠背"），
    // 这里要找的是最后一个否定短语**之后**的那次出现
    const from = negativeHit ? negativeHit.end : 0;
    const index = text.indexOf(keyword, from);
    if (index < 0) continue;
    positiveHit = { keyword, index };
    break;
  }

  if (positiveHit) {
    return {
      fieldKey: key,
      fieldType: "boolean",
      proposedValue: !isNegatedNear(text, positiveHit.index),
      evidence: extractEvidence(text, positiveHit.index, positiveHit.index + positiveHit.keyword.length),
    };
  }
  if (negativeHit) {
    return {
      fieldKey: key,
      fieldType: "boolean",
      proposedValue: false,
      evidence: extractEvidence(text, negativeHit.start, negativeHit.end),
    };
  }
  return null;
}

function matchEnum(
  text: string,
  key: string,
  property: AttributeProperty,
  rule: EnumRule,
): ExtractedSuggestion | null {
  const allowed = property.enum ? new Set(property.enum) : null;

  // 全局扫描所有枚举关键词。短词（quiet 的"安静"）与长短语
  // （very_quiet 的"最安静"）是不同值的关键词，必须在字段层面做最长匹配，
  // 否则短词会在同一位置先命中，把"最安静"误判成 quiet。
  const allOccurrences: Array<{ value: string; start: number; end: number }> = [];
  for (const [value, keywords] of Object.entries(rule.values)) {
    if (allowed && !allowed.has(value)) continue;
    // 显式否定短语（如"像木头"是比喻）直接排除该值
    const explicitlyNegated = (rule.negated?.[value] ?? []).some((phrase) => text.includes(phrase));
    if (explicitlyNegated) continue;

    for (const keyword of keywords) {
      let from = 0;
      for (;;) {
        const index = text.indexOf(keyword, from);
        if (index < 0) break;
        if (!isNegatedNear(text, index)) {
          allOccurrences.push({ value, start: index, end: index + keyword.length });
        }
        from = index + keyword.length;
      }
    }
  }

  // 去掉被更长关键词覆盖的短词命中（"安静"在"最安静"内部 → 丢弃）
  const hits = allOccurrences.filter(
    (occ) =>
      !allOccurrences.some(
        (other) =>
          other !== occ &&
          other.start <= occ.start &&
          other.end >= occ.end &&
          (other.end - other.start) > (occ.end - occ.start),
      ),
  );

  // 裁决：同一句内"不是 A，是 B"以更靠后的为准；
  // 跨句的多个值（自相矛盾的评论）也取最后一句的陈述。
  const chosen = hits.sort((a, b) => a.start - b.start).at(-1);
  if (!chosen) return null;

  return {
    fieldKey: key,
    fieldType: "string",
    proposedValue: chosen.value,
    evidence: extractEvidence(text, chosen.start, chosen.end),
  };
}

function matchInteger(
  text: string,
  key: string,
  property: AttributeProperty,
  rule: IntegerRule,
): ExtractedSuggestion | null {
  // 抓取数字 + 量词，如"能坐 4 个人""大概三个人的位置"
  const numberPattern = /(\d{1,3}|[一二两三四五六七八九十]{1,3})\s*(个人|人坐|个位置|个座位)/g;
  const match = numberPattern.exec(text);
  if (!match) return null;

  let amount: number;
  const raw = match[1]!;
  if (/^\d+$/.test(raw)) {
    amount = Number(raw);
  } else {
    amount = chineseNumberToInt(raw);
  }
  if (!Number.isFinite(amount) || amount <= 0) return null;
  if (property.minimum !== undefined && amount < property.minimum) return null;
  if (property.maximum !== undefined && amount > property.maximum) return null;

  const start = match.index;
  return {
    fieldKey: key,
    fieldType: "integer",
    proposedValue: amount,
    evidence: extractEvidence(text, start, start + match[0].length),
  };
}

function matchArray(
  text: string,
  key: string,
  property: AttributeProperty,
  rule: ArrayRule,
): ExtractedSuggestion | null {
  const allowed = property.items?.enum ? new Set(property.items.enum) : null;
  const values: string[] = [];
  let lastHit: { start: number; end: number } | null = null;

  for (const [value, keywords] of Object.entries(rule.values)) {
    if (allowed && !allowed.has(value)) continue;
    const hit = findKeyword(text, keywords);
    if (!hit || isNegatedNear(text, hit.start)) continue;
    values.push(value);
    if (!lastHit || hit.start > lastHit.start) lastHit = hit;
  }

  if (values.length === 0 || !lastHit) return null;
  return {
    fieldKey: key,
    fieldType: "array",
    proposedValue: values,
    evidence: extractEvidence(text, lastHit.start, lastHit.end),
  };
}

const CHINESE_DIGITS: Record<string, number> = {
  一: 1,
  二: 2,
  两: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  七: 7,
  八: 8,
  九: 9,
};

/** 只处理评论里实际会出现的 1–99 口语数字："三""十二""二十" */
export function chineseNumberToInt(raw: string): number {
  if (/^\d+$/.test(raw)) return Number(raw);
  if (raw === "十") return 10;

  const tenIndex = raw.indexOf("十");
  if (tenIndex >= 0) {
    const tens = tenIndex === 0 ? 1 : CHINESE_DIGITS[raw[tenIndex - 1]!];
    const onesChar = raw[tenIndex + 1];
    const ones = onesChar ? CHINESE_DIGITS[onesChar] ?? 0 : 0;
    return tens * 10 + ones;
  }
  return CHINESE_DIGITS[raw] ?? Number.NaN;
}

/**
 * 从一条评论里提取字段建议。
 * 只产出 Schema 里存在、条目当前未填写、且配置了规则的字段。
 */
export function extractDetailsFromText(
  text: string,
  schema: AttributeSchema,
  currentAttributes: Record<string, unknown>,
): ExtractedSuggestion[] {
  const results: ExtractedSuggestion[] = [];

  for (const [key, property] of Object.entries(schema.properties)) {
    // 条目作者已经填过的字段不再推：评论纠正已有信息属于"过期反馈"，
    // 走 confirm/stale 通道，由作者自己改，而不是用一条评论覆盖作者的选择。
    const current = currentAttributes[key];
    if (current !== undefined && current !== null && current !== "") continue;

    const rule = FIELD_RULES[key];
    if (!rule) continue;

    let match: ExtractedSuggestion | null = null;
    if (rule.kind === "boolean" && property.type === "boolean") {
      match = matchBoolean(text, key, property, rule);
    } else if (rule.kind === "enum" && property.type === "string") {
      match = matchEnum(text, key, property, rule);
    } else if (rule.kind === "integer" && property.type === "integer") {
      match = matchInteger(text, key, property, rule);
    } else if (rule.kind === "array" && property.type === "array") {
      match = matchArray(text, key, property, rule);
    }
    if (match) results.push(match);
  }

  return results;
}
