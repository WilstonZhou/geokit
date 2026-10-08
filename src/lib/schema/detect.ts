/**
 * 鲸析 GEOkit — 规则驱动的页面类型检测（T10）。
 *
 * 两级信号：
 *   强信号 = 页面顶层 JSON-LD @type（high 置信）
 *   弱信号 = 可见内容/meta 启发式（medium/low 置信）
 *
 * 每条判定都带依据（TypeSignal），规则常量全部导出，不做黑盒打分。
 * 判定不了就返回 unknown —— 不硬猜。
 */
import type { PageFacts } from "./extract";
import type {
  DetectionConfidence,
  PageType,
  PageTypeDetection,
  TypeSignal,
} from "./types";
import { sig } from "./extract";

/* ------------------------------------------------------------------ */
/* 规则常量（透明可测）                                                */
/* ------------------------------------------------------------------ */

/** 内容实体类型 —— 一旦在顶层出现，优先于 Organization/WebSite 等结构类型 */
export const CONTENT_TYPE_PRIORITY: PageType[] = [
  "faq",
  "howto",
  "product",
  "local-business",
  "article",
];

export const TYPE_PATTERNS: { type: PageType; re: RegExp }[] = [
  { type: "faq", re: /FAQPage|QAPage/i },
  { type: "howto", re: /HowTo|Recipe/i },
  {
    type: "product",
    re: /^(Product|ProductGroup|ProductModel|IndividualProduct|Vehicle|OfferCatalog)$/i,
  },
  {
    type: "local-business",
    re: /(LocalBusiness|Restaurant|FoodEstablishment|CafeOrCoffeeShop|Store|ProfessionalService|AutomotiveBusiness|LodgingBusiness|FinancialService|LegalService|MedicalBusiness|HealthAndBeautyBusiness|HomeAndConstructionBusiness|EmergencyService|TravelAgency|RealEstateAgent|TouristInformationCenter)$/i,
  },
  { type: "article", re: /(Article|BlogPosting|NewsArticle|TechArticle|Report|WebPageElement)/i },
];

export const ORG_TYPE_RE =
  /^(Organization|NGO|Corporation|EducationalOrganization|GovernmentOrganization|PerformingGroup)$/i;
export const WEBSITE_TYPE_RE = /^WebSite$/i;

/** 弱信号门槛 */
export const FAQ_MIN_QUESTIONS = 2;
export const HOWTO_MIN_STEPS = 2;
export const ARTICLE_MIN_WORDS = 300;

/* ------------------------------------------------------------------ */
/* 检测                                                                */
/* ------------------------------------------------------------------ */

interface Candidate {
  type: PageType;
  confidence: DetectionConfidence;
  signals: TypeSignal[];
}

/** 同置信度下的排序优先级：内容类型在前，组织/官网在后 */
const TYPE_ORDER: PageType[] = [
  "faq",
  "howto",
  "product",
  "local-business",
  "article",
  "organization",
  "website",
  "unknown",
];
const CONF_RANK: Record<DetectionConfidence, number> = { high: 0, medium: 1, low: 2 };

export function detectPageType(facts: PageFacts): PageTypeDetection {
  const candidates = new Map<PageType, Candidate>();

  const add = (c: Candidate) => {
    const exist = candidates.get(c.type);
    if (!exist || CONF_RANK[c.confidence] < CONF_RANK[exist.confidence]) {
      candidates.set(c.type, c);
    } else {
      exist.signals.push(...c.signals);
    }
  };

  // ── 强信号：顶层 JSON-LD 内容类型 ──
  const hasContentEntity = new Set<PageType>();
  for (const { type, re } of TYPE_PATTERNS) {
    const hit = facts.rootTypes.find((t) => re.test(t));
    if (hit) {
      hasContentEntity.add(type);
      add({
        type,
        confidence: "high",
        signals: [sig("jsonld", "root:@type", hit)],
      });
    }
  }

  // ── 弱信号启发式（仅在没有该类型的强信号时补充） ──

  // FAQ：≥2 个疑问句标题且后跟答案段
  if (!hasContentEntity.has("faq") && facts.qaPairs.length >= FAQ_MIN_QUESTIONS) {
    add({
      type: "faq",
      confidence: "medium",
      signals: [
        sig(
          "visible",
          "heading:questions",
          `${facts.qaPairs.length} 个问答对（${facts.qaPairs[0]!.question.slice(0, 24)}…）`
        ),
      ],
    });
  }

  // HowTo：≥2 个有序步骤
  if (!hasContentEntity.has("howto") && facts.steps.length >= HOWTO_MIN_STEPS) {
    add({
      type: "howto",
      confidence: "medium",
      signals: [
        sig("visible", "content:steps", `检测到 ${facts.steps.length} 个步骤`),
      ],
    });
  }

  // Product：价格 + 购买动作
  if (!hasContentEntity.has("product") && facts.prices.length > 0) {
    if (facts.hasBuyAction) {
      add({
        type: "product",
        confidence: "medium",
        signals: [
          sig("visible", "content:price", facts.prices[0]!.raw),
          sig("visible", "content:buyAction", "购买/加购按钮"),
        ],
      });
    } else {
      add({
        type: "product",
        confidence: "low",
        signals: [sig("visible", "content:price", facts.prices[0]!.raw)],
      });
    }
  }

  // LocalBusiness：电话 + 地址
  if (!hasContentEntity.has("local-business")) {
    if (facts.tel.length > 0 && facts.addressHints.length > 0) {
      add({
        type: "local-business",
        confidence: "medium",
        signals: [
          sig("visible", "link:tel", facts.tel[0]!),
          sig("visible", "content:address", facts.addressHints[0]!),
        ],
      });
    } else if (facts.tel.length > 0 || facts.addressHints.length > 0) {
      add({
        type: "local-business",
        confidence: "low",
        signals: [
          facts.tel[0]
            ? sig("visible", "link:tel", facts.tel[0])
            : sig("visible", "content:address", facts.addressHints[0]!),
        ],
      });
    }
  }

  // Article：发布时间 meta，或署名/可见日期 + 长文
  if (!hasContentEntity.has("article")) {
    if (facts.publishedRaw) {
      add({
        type: "article",
        confidence: "medium",
        signals: [
          sig("meta", "article:published_time", facts.publishedRaw),
        ],
      });
    } else if (
      facts.wordCount >= ARTICLE_MIN_WORDS &&
      (facts.author || facts.visibleDates.length > 0)
    ) {
      add({
        type: "article",
        confidence: "low",
        signals: [
          sig(
            "visible",
            "content:longform",
            `${facts.wordCount} 字${facts.author ? "+署名" : ""}+可见日期`
          ),
        ],
      });
    }
  }

  // ── 结构类型：仅当没有任何内容实体时才允许登顶 ──
  const noContentEntity = hasContentEntity.size === 0;

  if (noContentEntity && facts.rootTypes.some((t) => ORG_TYPE_RE.test(t))) {
    const hit = facts.rootTypes.find((t) => ORG_TYPE_RE.test(t))!;
    add({
      type: "organization",
      confidence: "high",
      signals: [sig("jsonld", "root:@type", hit)],
    });
  }
  if (noContentEntity && isAboutOrContact(facts)) {
    add({
      type: "organization",
      confidence: "low",
      signals: [
        sig(
          "url",
          "page:about-contact",
          "关于/联系页面特征（标题或路径）+ 联系方式"
        ),
      ],
    });
  }

  if (noContentEntity && facts.rootTypes.some((t) => WEBSITE_TYPE_RE.test(t))) {
    add({
      type: "website",
      confidence: "high",
      signals: [sig("jsonld", "root:@type", "WebSite")],
    });
  }
  if (noContentEntity && isHomepage(facts.url)) {
    add({
      type: "website",
      confidence: "low",
      signals: [sig("url", "url:homepage", "站点根路径")],
    });
  }

  // ── 排序选主 ──
  const sorted = Array.from(candidates.values()).sort(
    (a, b) =>
      CONF_RANK[a.confidence] - CONF_RANK[b.confidence] ||
      TYPE_ORDER.indexOf(a.type) - TYPE_ORDER.indexOf(b.type)
  );

  if (sorted.length === 0) {
    return {
      type: "unknown",
      confidence: "low",
      signals: [],
      candidates: [{ type: "unknown", confidence: "low" }],
    };
  }

  const primary = sorted[0]!;
  return {
    type: primary.type,
    confidence: primary.confidence,
    signals: primary.signals,
    candidates: sorted.map((c) => ({ type: c.type, confidence: c.confidence })),
  };
}

/** 关于我们/联系我们页面特征 */
function isAboutOrContact(facts: PageFacts): boolean {
  const path = safePath(facts.url);
  const pathHit = /(about|contact|guan-yu|lian-xi|guanyu|lianxi)/i.test(path);
  const titleHit = /关于我们|联系我们|关于公司|About\s+Us|Contact\s+Us/i.test(
    facts.title ?? ""
  );
  const hasContact = facts.tel.length > 0 || facts.mailto.length > 0;
  return (pathHit || titleHit) && hasContact;
}

function isHomepage(u: string): boolean {
  const path = safePath(u);
  return path === "" || path === "/";
}

function safePath(u: string): string {
  try {
    return new URL(/^https?:\/\//i.test(u) ? u : `https://${u}`).pathname;
  } catch {
    return "";
  }
}
