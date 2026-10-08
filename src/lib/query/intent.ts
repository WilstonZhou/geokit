/**
 * 鲸析 GEOkit — Query 意图分类（T7）
 *
 * 规则驱动判定 5 种意图：informational / comparative / transactional / local / navigational。
 *
 * 判定依据两类信号：
 *   1. query 文本特征（关键词模式）
 *   2. SERP 结构特征（结果类型分布）
 *
 * 多条规则命中时按优先级（navigational > transactional > local > comparative > informational）
 * 取首个，置信度按命中规则数与唯一性决定。所有命中规则写入 basis，结论可追溯。
 */

import type { IntentClassification, QueryIntent, IntentConfidence } from "./types";
import type { SerpResponse } from "../serp";

/* ------------------------------------------------------------------ */
/* 规则常量 —— 透明可测                                                */
/* ------------------------------------------------------------------ */

/** 5 类意图的判定优先级（数值小者优先） */
export const INTENT_PRIORITY: Record<QueryIntent, number> = {
  navigational: 0,
  transactional: 1,
  local: 2,
  comparative: 3,
  informational: 4,
};

interface Rule {
  intent: QueryIntent;
  /** query 文本关键词（命中任意一个即触发） */
  keywords: string[];
  /** 触发后写入 basis 的描述 */
  basisLabel: string;
}

const TEXT_RULES: Rule[] = [
  {
    intent: "navigational",
    keywords: ["登录", "官网", "登陆", "login", "sign in", "register", "注册"],
    basisLabel: "query 含导航词（登录/官网/login）",
  },
  {
    intent: "transactional",
    keywords: [
      "买", "购买", "价格", "报价", "优惠", "打折", "折扣", "下单", "订单",
      "buy", "price", "deal", "coupon", "discount", "order", "cheap",
    ],
    basisLabel: "query 含交易词（买/价格/优惠）",
  },
  {
    intent: "local",
    keywords: [
      "附近", "就近", "在哪", "地址", "营业时间", "电话",
      "near me", "nearby", "address", "directions", "hours",
    ],
    basisLabel: "query 含本地词（附近/地址/near me）",
  },
  {
    intent: "comparative",
    keywords: [
      "vs", "对比", "比较", "区别", "哪个好", "哪个更好", "评测",
      "compare", "comparison", "difference", "versus", "best",
    ],
    basisLabel: "query 含对比词（vs/对比/区别）",
  },
  {
    intent: "informational",
    keywords: [
      "怎么", "如何", "为什么", "是什么", "什么是", "成因", "原理",
      "how to", "how do", "how does", "why", "what is", "what are",
      "guide", "教程", "原理", "意思",
    ],
    basisLabel: "query 含信息词（怎么/为什么/是什么）",
  },
];

/* ------------------------------------------------------------------ */
/* SERP 结构特征                                                       */
/* ------------------------------------------------------------------ */

/**
 * 从 SERP 响应里提取结构特征。
 *
 * - hasQuestionInItems: 结果标题里出现问号或问句词 → 偏 informational
 * - topResultIsSelfOwned: 顶部结果是引擎自家产品 → 偏 navigational
 * - shoppingHints: 域名含 shopping/shop/taobao/jd 等电商 → 偏 transactional
 * - mapPackHints: 域名含 map/dianping/meituan 等本地服务 → 偏 local
 */
interface SerpFeatures {
  hasQuestionInItems: boolean;
  topResultIsSelfOwned: boolean;
  shoppingHints: boolean;
  mapPackHints: boolean;
}

const SHOPPING_DOMAINS = ["taobao", "tmall", "jd.com", "pinduoduo", "amazon", "shop", "shopee"];
const LOCAL_DOMAINS = ["dianping", "meituan", "map.baidu", "amap", "google.maps", "yelp"];

function extractSerpFeatures(serp: SerpResponse[]): SerpFeatures {
  const items = serp.flatMap((s) => s.items);
  const topItem = items.find((i) => i.position === 1);
  const hasQuestionInItems = items.some((i) =>
    i.title.includes("?") || i.title.includes("？") ||
    /^(怎么|如何|为什么|是什么|什么是)/.test(i.title)
  );
  const topResultIsSelfOwned = topItem?.owned ?? false;
  const shoppingHints = items.some((i) =>
    SHOPPING_DOMAINS.some((d) => i.domain.includes(d))
  );
  const mapPackHints = items.some((i) =>
    LOCAL_DOMAINS.some((d) => i.domain.includes(d))
  );
  return { hasQuestionInItems, topResultIsSelfOwned, shoppingHints, mapPackHints };
}

/* ------------------------------------------------------------------ */
/* 主入口                                                              */
/* ------------------------------------------------------------------ */

/**
 * 分类 query 意图。
 *
 * @param query       查询文本
 * @param serpResults 可选 SERP 结构特征（强化或弱化置信度）
 * @returns IntentClassification —— intent / confidence / basis
 */
export function classifyIntent(
  query: string,
  serpResults?: SerpResponse[]
): IntentClassification {
  const q = query.toLowerCase().trim();
  const basis: string[] = [];
  /** 命中的意图集合（同一意图可能由多条规则命中） */
  const hits = new Map<QueryIntent, number>();

  // 1. query 文本规则
  for (const rule of TEXT_RULES) {
    for (const kw of rule.keywords) {
      if (q.includes(kw.toLowerCase())) {
        hits.set(rule.intent, (hits.get(rule.intent) ?? 0) + 1);
        basis.push(rule.basisLabel);
        break; // 每条规则只计一次
      }
    }
  }

  // 2. SERP 结构特征（仅在有 SERP 数据时强化）
  if (serpResults && serpResults.length > 0) {
    const f = extractSerpFeatures(serpResults);
    if (f.topResultIsSelfOwned) {
      hits.set("navigational", (hits.get("navigational") ?? 0) + 1);
      basis.push("SERP 顶部为引擎自家产品");
    }
    if (f.shoppingHints) {
      hits.set("transactional", (hits.get("transactional") ?? 0) + 1);
      basis.push("SERP 出现电商域名");
    }
    if (f.mapPackHints) {
      hits.set("local", (hits.get("local") ?? 0) + 1);
      basis.push("SERP 出现本地服务域名");
    }
    if (f.hasQuestionInItems) {
      hits.set("informational", (hits.get("informational") ?? 0) + 1);
      basis.push("SERP 结果标题含问句");
    }
  }

  // 3. 选定主意图：按优先级取首个命中
  let chosen: QueryIntent;
  if (hits.size === 0) {
    // 无任何规则命中 —— 默认 informational，低置信
    chosen = "informational";
    basis.push("默认 informational（无规则命中）");
  } else {
    const sorted = Array.from(hits.keys()).sort(
      (a, b) => INTENT_PRIORITY[a] - INTENT_PRIORITY[b]
    );
    chosen = sorted[0];
  }

  // 4. 置信度：命中数≥2 → high；命中数=1 且非默认 → medium；默认 → low
  const totalHits = Array.from(hits.values()).reduce((a, b) => a + b, 0);
  let confidence: IntentConfidence;
  if (totalHits >= 2) confidence = "high";
  else if (totalHits === 1 && hits.size > 0) confidence = "medium";
  else confidence = "low";

  return { intent: chosen, confidence, basis };
}
