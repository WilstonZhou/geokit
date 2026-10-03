import type { GeoInput, GeoResult, GeoVersion } from "./types";
import { computeGeoV1 } from "./v1";
import { computeGeoV2 } from "./v2";

export * from "./types";
export { computeGeoV1 } from "./v1";
export { computeGeoV2 } from "./v2";

/**
 * 计算页面的 GEO（生成式引擎优化）评分。
 *
 * @param input 提取的页面结构、内容形态与元数据输入
 * @param version 评分模型版本，默认为 "1.0.0" 以确保历史基线兼容
 */
export function computeGeo(input: GeoInput, version: GeoVersion = "1.0.0"): GeoResult {
  switch (version) {
    case "2.0.0":
      return computeGeoV2(input);
    case "1.0.0":
    default:
      return computeGeoV1(input);
  }
}
