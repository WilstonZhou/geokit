/**
 * 鲸析 GEOkit — 实体清晰度检查（T10 任务 3）。
 *
 * 作者、组织、sameAs、联系方式、发布/更新时间是否被标注。
 * 来源优先级：JSON-LD > meta > 页面可见内容；每一项都给出来源与观测值。
 */
import type { PageFacts } from "./extract";
import { nodesOfType, deepStr } from "./extract";
import type { EntityClarity, EntitySignal } from "./types";

function fromJson(value: string | undefined): EntitySignal {
  return value ? { present: true, value, source: "jsonld" } : { present: false };
}

/** 在任一原始节点中找第一个非空深路径值 */
function firstDeep(nodes: Record<string, unknown>[], ...path: string[]) {
  for (const n of nodes) {
    const v = deepStr(n, ...path);
    if (v) return v;
  }
  return undefined;
}

export function checkEntityClarity(facts: PageFacts): EntityClarity {
  const articleNodes = nodesOfType(
    facts.jsonLdNodes,
    /Article|BlogPosting|NewsArticle|TechArticle|Book|Recipe|HowTo/i
  ).map((n) => n.node);
  const orgNodes = nodesOfType(
    facts.jsonLdNodes,
    /Organization|NGO|Corporation|LocalBusiness|Restaurant|Store/i
  ).map((n) => n.node);
  const personNodes = nodesOfType(facts.jsonLdNodes, /Person/i).map((n) => n.node);
  const anyNode = facts.jsonLdNodes.map((n) => n.node);

  // ── 作者 ──
  let author: EntitySignal = fromJson(
    firstDeep(articleNodes, "author", "name") ?? firstDeep(personNodes, "name")
  );
  if (!author.present && facts.author) {
    author = { present: true, value: facts.author, source: "meta" };
  }

  // ── 组织 ──
  let organization: EntitySignal = fromJson(
    firstDeep(orgNodes, "name") ?? firstDeep(anyNode, "publisher", "name")
  );
  if (!organization.present && facts.ogSiteName) {
    organization = { present: true, value: facts.ogSiteName, source: "meta" };
  }

  // ── sameAs ──
  let sameAs: EntitySignal = { present: false };
  for (const n of anyNode) {
    const v = n["sameAs"];
    const arr = Array.isArray(v) ? v.filter((x) => typeof x === "string" && x) : [];
    if (arr.length > 0) {
      sameAs = { present: true, value: `sameAs×${arr.length}`, source: "jsonld" };
      break;
    }
  }
  if (!sameAs.present && facts.socialLinks.length > 0) {
    sameAs = {
      present: true,
      value: `${facts.socialLinks.length} 个权威/社交外链`,
      source: "visible",
    };
  }

  // ── 联系方式 ──
  let contact: EntitySignal = fromJson(
    firstDeep(anyNode, "telephone") ??
      firstDeep(anyNode, "contactPoint", "telephone") ??
      firstDeep(anyNode, "contactPoint", "email")
  );
  if (!contact.present) {
    if (facts.tel.length > 0) {
      contact = { present: true, value: facts.tel[0], source: "visible" };
    } else if (facts.mailto.length > 0) {
      contact = { present: true, value: facts.mailto[0], source: "visible" };
    } else if (facts.addressHints.length > 0) {
      contact = { present: true, value: facts.addressHints[0], source: "visible" };
    }
  }

  // ── 发布时间 ──
  let datePublished: EntitySignal = fromJson(firstDeep(articleNodes, "datePublished"));
  if (!datePublished.present && facts.publishedRaw) {
    datePublished = {
      present: true,
      value: facts.publishedDate ?? facts.publishedRaw,
      source: "meta",
    };
  }

  // ── 更新时间 ──
  let dateModified: EntitySignal = fromJson(firstDeep(articleNodes, "dateModified"));
  if (!dateModified.present && facts.modifiedRaw) {
    dateModified = {
      present: true,
      value: facts.modifiedDate ?? facts.modifiedRaw,
      source: "meta",
    };
  }

  return { author, organization, sameAs, contact, datePublished, dateModified };
}
