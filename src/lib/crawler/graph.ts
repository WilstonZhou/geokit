/**
 * 鲸析 GEOkit — 站点图构建（T3）
 *
 * 输入：爬好的 CrawlPage 列表（含每页的 outLinks）+ sitemap URL 集合。
 * 输出：SiteGraph（节点 + 边）。
 *
 * 关键规则：
 *   - 节点 = 所有爬到的页面（url / clickDepth 来自 CrawlPage）
 *   - 边 = 每页的 outLinks → {from: page.url, to: link}
 *   - inlinks = 边的目标为该 URL 的数量
 *   - orphan = sitemap 里出现但 inlinks === 0
 *
 * 循环引用（A→B→A）天然不会让构建崩溃：边按 from→to 平铺，
 * inlinks 是计数而不是集合，重入边被自然算成 2。
 */
import type { CrawlPage, SiteGraph, GraphNode, GraphEdge } from "./types";

export function buildSiteGraph(
  pages: CrawlPage[],
  sitemapUrls: string[]
): SiteGraph {
  const pageUrls = new Set(pages.map((p) => p.url));
  const sitemapSet = new Set(sitemapUrls);

  // 节点：每个爬到的页面一个
  const nodes: GraphNode[] = pages.map((p) => ({
    url: p.url,
    inlinks: 0, // 后面回填
    clickDepth: p.clickDepth,
    orphan: false, // 下面修正
  }));

  // 边：每页 outLinks → {from, to}
  // 只保留目标也是已爬页面的边（避免图里出现幽灵节点）；
  // 同一对 from→to 重复也保留 —— 真实页面同一条链接出现两次是合法的，
  // 但用于入链计数时只算一次（见下面 inlinks 用 Set 去重）。
  const edges: GraphEdge[] = [];
  const inlinkCount = new Map<string, Set<string>>();
  for (const p of pages) {
    for (const to of p.outLinks) {
      if (!pageUrls.has(to)) continue;
      edges.push({ from: p.url, to });
      if (!inlinkCount.has(to)) inlinkCount.set(to, new Set());
      inlinkCount.get(to)!.add(p.url);
    }
  }

  for (const n of nodes) {
    const inSet = inlinkCount.get(n.url);
    n.inlinks = inSet ? inSet.size : 0;
    // orphan 判定：sitemap 声明里有它，且没有任何站内入链
    n.orphan = sitemapSet.has(n.url) && n.inlinks === 0;
  }

  return { nodes, edges };
}
