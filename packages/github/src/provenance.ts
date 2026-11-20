import { createHash } from "node:crypto";

export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function sourceUrl(
  repositoryUrl: string,
  commitSha: string,
  path: string,
  startLine: number,
  endLine: number
): string {
  const encodedPath = path.split("/").map(encodeURIComponent).join("/");
  const range = startLine === endLine ? `#L${startLine}` : `#L${startLine}-L${endLine}`;
  return `${repositoryUrl}/blob/${commitSha}/${encodedPath}${range}`;
}
