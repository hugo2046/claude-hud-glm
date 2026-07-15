import * as fs from "node:fs";
import * as path from "node:path";
import { getHudPluginDir } from "./claude-config-dir.js";

const CACHE_DIRNAME = "glm-quota";
const CACHE_FILENAME = "glm-quota.json";

export const GLM_QUOTA_TTL_MS = 240_000;

export function getCachePath(homeDir) {
  return path.join(getHudPluginDir(homeDir), CACHE_DIRNAME, CACHE_FILENAME);
}

export function readCache(homeDir) {
  const cachePath = getCachePath(homeDir);
  if (!fs.existsSync(cachePath)) return null;
  try {
    const obj = JSON.parse(fs.readFileSync(cachePath, "utf8"));
    if (typeof obj?.savedAt !== "number") return null;
    return obj;
  } catch {
    return null;
  }
}

export function writeCache(homeDir, payload, now) {
  const cachePath = getCachePath(homeDir);
  const dir = path.dirname(cachePath);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = path.join(dir, `.${path.basename(cachePath)}.${process.pid}.${now}.tmp`);
  const data = { savedAt: now, ...payload };
  fs.writeFileSync(tmp, JSON.stringify(data) + "\n", { mode: 0o600, flag: "wx" });
  fs.renameSync(tmp, cachePath);
  fs.chmodSync(cachePath, 0o600);
}
