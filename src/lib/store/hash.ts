import { createHash } from "node:crypto";

/** 稳定 hash。用于去重键与身份键 —— 必须是确定性的，不能用随机 id 参与 */
export function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

/** 用 \u0001 作分隔符：它不可能出现在 subject / url 这些字段里，避免拼接歧义 */
export function keyOf(...parts: (string | undefined | null)[]): string {
  return sha256Hex(parts.map((p) => p ?? "").join(""));
}
