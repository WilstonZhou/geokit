/**
 * `geokit check <url>`（Phase 2 · S2-2）。
 *
 * 核心实现已下沉到 `src/lib/services/diagnosis.ts`，供 CLI、MCP 与 HTTP API 共享。
 * 本文件保留全部导出，保持对现有 CLI / CI / 测试的 100% 向后兼容。
 */
export {
  MUST_ALLOW_CRAWLERS,
  type SeverityCounts,
  type CheckReport,
  type CheckOptions,
  checkUrl,
  checkHtml,
  checkFailure,
  buildCheckReport,
  diagnoseProtocol,
  exitCodeFor,
  autoFixHtml,
} from "../../../src/lib/services/diagnosis";
