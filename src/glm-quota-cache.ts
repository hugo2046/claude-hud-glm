import * as fs from "node:fs";
import * as path from "node:path";
import { getHudPluginDir } from "./claude-config-dir.js";

const CACHE_DIRNAME = "glm-quota";
const CACHE_FILENAME = "glm-quota.json";

/** 缓存新鲜度窗口（毫秒）。TTL 判断在 getZhipuUsage，readCache 不判。 */
export const GLM_QUOTA_TTL_MS = 240_000;

export interface CachedQuota {
  savedAt: number;
  fiveHour: number | null;
  sevenDay: number | null;
  fiveHourResetAt: string | null;
  sevenDayResetAt: string | null;
  level: string | null;
}

export type GlmQuotaPayload = Omit<CachedQuota, "savedAt">;

/** 缓存文件绝对路径：~/.claude/plugins/claude-hud/glm-quota/glm-quota.json */
export function getCachePath(homeDir: string): string {
  return path.join(getHudPluginDir(homeDir), CACHE_DIRNAME, CACHE_FILENAME);
}

/** 读缓存；不存在或 JSON 损坏返回 null。不判 TTL（新鲜度由调用方判断）。 */
export function readCache(homeDir: string): CachedQuota | null {
  const cachePath = getCachePath(homeDir);
  if (!fs.existsSync(cachePath)) return null;
  try {
    const obj = JSON.parse(fs.readFileSync(cachePath, "utf8")) as Partial<CachedQuota>;
    if (typeof obj?.savedAt !== "number") return null;
    return obj as CachedQuota;
  } catch {
    return null;
  }
}

/** 原子写缓存：mkdir 0700 → tmp(wx, 0600) → rename → chmod 0600。 */
export function writeCache(homeDir: string, payload: GlmQuotaPayload, now: number): void {
  const cachePath = getCachePath(homeDir);
  const dir = path.dirname(cachePath);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = path.join(dir, `.${path.basename(cachePath)}.${process.pid}.${now}.tmp`);
  const data: CachedQuota = { savedAt: now, ...payload };
  fs.writeFileSync(tmp, JSON.stringify(data) + "\n", { mode: 0o600, flag: "wx" });
  fs.renameSync(tmp, cachePath);
  fs.chmodSync(cachePath, 0o600);
}
