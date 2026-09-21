/**
 * 鲸析 GEOkit — 搜索引擎注册表
 *
 * open-seo 的代码里 google 出现 973 次、bing 7 次、百度 0 次、搜狗 0 次。
 * 这个文件就是 GEOkit 存在的核心理由之一：把中文搜索引擎当作一等公民。
 *
 * 每个引擎描述“怎么问”和“怎么 parse”，不强依赖任何付费 API。
 */

export type EngineId =
  | "baidu"
  | "sogou"
  | "so360"
  | "google"
  | "bing"
  | "shenma"
  | "toutiao";

export interface SearchEngine {
  id: EngineId;
  /** 中文名 */
  name: string;
  /** 英文名，用于 report */
  nameEn: string;
  /** 主域名，用于识别结果是否属于自己 */
  domain: string;
  /** 搜索结果页 URL 模板，{q} 替换关键词，{pn} 替换分页偏移 */
  searchUrl: (q: string, offset: number) => string;
  /** 该引擎每页结果数，用于计算自然排名 */
  resultsPerPage: number;
  /** 结果链接选择器（CSS selector 列表，按优先级） */
  resultSelectors: string[];
  /** 是否需要在结果里过滤掉自家站内结果（如百度百科/贴吧权重特殊） */
  ownedProperties: string[];
  /** 桌面端 User-Agent，部分引擎对 UA 敏感 */
  userAgent: string;
  /** 市场备注 */
  market: string;
  /** 大致市场份额（中国，2025-2026 公开估算），仅用于 UI 展示 */
  shareCn: number;
  enabled: boolean;
}

const DESKTOP_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36";

export const ENGINES: Record<EngineId, SearchEngine> = {
  baidu: {
    id: "baidu",
    name: "百度",
    nameEn: "Baidu",
    domain: "baidu.com",
    searchUrl: (q, offset) =>
      `https://www.baidu.com/s?wd=${encodeURIComponent(q)}&rn=50&pn=${offset}`,
    resultsPerPage: 50,
    resultSelectors: ["div.result[mu]", "div.result", ".c-container"],
    ownedProperties: ["baike.baidu.com", "tieba.baidu.com", "zhidao.baidu.com"],
    userAgent: DESKTOP_UA,
    market: "中国大陆桌面 + 移动，中文 SEO 主战场",
    shareCn: 55.6,
    enabled: true,
  },
  sogou: {
    id: "sogou",
    name: "搜狗",
    nameEn: "Sogou",
    domain: "sogou.com",
    searchUrl: (q, offset) =>
      `https://www.sogou.com/web?query=${encodeURIComponent(q)}&page=${
        Math.floor(offset / 10) + 1
      }`,
    resultsPerPage: 10,
    resultSelectors: ["div.vrwrap", "div.rb", ".results .vrwrap"],
    ownedProperties: ["baike.sogou.com", "wenwen.sogou.com"],
    userAgent: DESKTOP_UA,
    market: "中国大陆，微信生态搜索默认入口之一",
    shareCn: 12.4,
    enabled: true,
  },
  so360: {
    id: "so360",
    name: "360 搜索",
    nameEn: "360 Search",
    domain: "so.com",
    searchUrl: (q, offset) =>
      `https://www.so.com/s?q=${encodeURIComponent(q)}&pn=${
        Math.floor(offset / 10) + 1
      }`,
    resultsPerPage: 10,
    resultSelectors: ["li.res-list", ".result", "li[data-md5]"],
    ownedProperties: ["baike.so.com", "wenda.so.com"],
    userAgent: DESKTOP_UA,
    market: "中国大陆，安全卫士/浏览器渠道流量",
    shareCn: 18.3,
    enabled: true,
  },
  shenma: {
    id: "shenma",
    name: "神马搜索",
    nameEn: "Shenma",
    domain: "sm.cn",
    searchUrl: (q, offset) =>
      `https://m.sm.cn/s?q=${encodeURIComponent(q)}&page=${
        Math.floor(offset / 10) + 1
      }`,
    resultsPerPage: 10,
    resultSelectors: [".result-item", ".cu-item", "div.result"],
    ownedProperties: [],
    userAgent:
      "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
    market: "中国移动搜索，UC 浏览器默认",
    shareCn: 6.1,
    enabled: true,
  },
  toutiao: {
    id: "toutiao",
    name: "头条搜索",
    nameEn: "Toutiao Search",
    domain: "toutiao.com",
    searchUrl: (q, offset) =>
      `https://so.toutiao.com/search?dvpf=pc&keyword=${encodeURIComponent(
        q
      )}&offset=${offset}`,
    resultsPerPage: 10,
    resultSelectors: [".result-content", "div[data-log-id]", ".cs-view-block"],
    ownedProperties: ["toutiao.com", "dingyuehao.toutiao.com"],
    userAgent: DESKTOP_UA,
    market: "字节系内容搜索，内容型站点新入口",
    shareCn: 3.9,
    enabled: true,
  },
  google: {
    id: "google",
    name: "Google",
    nameEn: "Google",
    domain: "google.com",
    searchUrl: (q, offset) =>
      `https://www.google.com/search?q=${encodeURIComponent(
        q
      )}&num=10&start=${offset}`,
    resultsPerPage: 10,
    resultSelectors: ["div.g", "div[data-hveid]"],
    ownedProperties: [],
    userAgent: DESKTOP_UA,
    market: "全球 / 出海业务",
    shareCn: 2.1,
    enabled: true,
  },
  bing: {
    id: "bing",
    name: "Bing",
    nameEn: "Bing",
    domain: "bing.com",
    searchUrl: (q, offset) =>
      `https://www.bing.com/search?q=${encodeURIComponent(q)}&first=${
        offset + 1
      }`,
    resultsPerPage: 10,
    resultSelectors: ["li.b_algo", ".b_results li.b_algo"],
    ownedProperties: [],
    userAgent: DESKTOP_UA,
    market: "全球 / 也是 ChatGPT 搜索的底层索引",
    shareCn: 1.6,
    enabled: true,
  },
};

export const ENGINE_LIST: SearchEngine[] = Object.values(ENGINES);

export const CN_ENGINES: EngineId[] = ["baidu", "so360", "sogou", "shenma", "toutiao"];
export const GLOBAL_ENGINES: EngineId[] = ["google", "bing"];

export function getEngine(id: string): SearchEngine | undefined {
  return ENGINES[id as EngineId];
}

export function isCnEngine(id: EngineId): boolean {
  return CN_ENGINES.includes(id);
}
