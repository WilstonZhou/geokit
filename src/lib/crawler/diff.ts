/**
 * 鲸析 GEOkit — 爬取结果 diff（T3）
 *
 * 镜像 visibility/aggregate.ts 的 diffCitationRecords 模式：
 *   - 按 URL 匹配前后两次爬取
 *   - added = 本次有、上次无
 *   - removed = 上次有、本次无
 *   - statusChanged = 都在但 httpStatus 或 title 不同
 *   - unchangedCount = 都在且状态+标题相同
 *
 * 跨时间口径的判定不靠时间戳：调用方传入「前」与「后」即可，
 * 与 diffCitationRecords 一致。
 */
import type { CrawlResult, CrawlDiff, CrawlDiffEntry } from "./types";

export function diffCrawlResults(prev: CrawlResult, cur: CrawlResult): CrawlDiff {
  const prevMap = new Map(prev.pages.map((p) => [p.url, p]));
  const curMap = new Map(cur.pages.map((p) => [p.url, p]));

  const added: string[] = [];
  const removed: string[] = [];
  const statusChanged: CrawlDiffEntry[] = [];
  let unchangedCount = 0;

  for (const [url, curPage] of curMap) {
    const prevPage = prevMap.get(url);
    if (!prevPage) {
      added.push(url);
      continue;
    }
    const statusDiff = prevPage.httpStatus !== curPage.httpStatus;
    const titleDiff =
      (prevPage.title ?? null) !== (curPage.title ?? null);
    if (statusDiff || titleDiff) {
      statusChanged.push({
        url,
        status: "status-changed",
        prevStatus: prevPage.httpStatus,
        curStatus: curPage.httpStatus,
        prevTitle: prevPage.title,
        curTitle: curPage.title,
      });
    } else {
      unchangedCount++;
    }
  }

  for (const [url] of prevMap) {
    if (!curMap.has(url)) removed.push(url);
  }

  return { added, removed, statusChanged, unchangedCount };
}
