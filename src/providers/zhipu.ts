import type { UsageData } from "../types.js";
import {
  GLM_QUOTA_TTL_MS,
  readCache,
  writeCache,
  type GlmQuotaPayload,
} from "../glm-quota-cache.js";

const ZHIPU_HOSTS = ["bigmodel.cn", "z.ai"];
const QUOTA_PATH = "/api/monitor/usage/quota/limit";
const FETCH_TIMEOUT_MS = 5_000;

/** 检测是否走智谱官方端点（base_url 含 bigmodel.cn / z.ai）。 */
export function isZhipuProvider(env: NodeJS.ProcessEnv): boolean {
  const base = env.ANTHROPIC_BASE_URL ?? env.ZHIPU_BASE_URL ?? "";
  return ZHIPU_HOSTS.some((h) => base.includes(h));
}

/** 从环境解析智谱凭证与 host。缺 key / 非官方域名抛错。 */
export function getZhipuCredentials(env: NodeJS.ProcessEnv): {
  apiKey: string;
  host: string;
} {
  const apiKey = env.ZHIPUAI_API_KEY ?? env.ANTHROPIC_AUTH_TOKEN;
  if (!apiKey) {
    throw new Error(
      "zhipu api key not found in env (ZHIPUAI_API_KEY / ANTHROPIC_AUTH_TOKEN)",
    );
  }
  const base = env.ANTHROPIC_BASE_URL ?? env.ZHIPU_BASE_URL;
  let host: string;
  if (base) {
    const u = new URL(base);
    host = `${u.protocol}//${u.host}`;
  } else {
    host = "https://open.bigmodel.cn";
  }
  if (!ZHIPU_HOSTS.some((h) => host.includes(h))) {
    throw new Error(`base_url is not a zhipu official domain (suspected proxy): ${host}`);
  }
  return { apiKey, host };
}

function clampPct(x: unknown): number | null {
  if (typeof x !== "number" || !Number.isFinite(x)) return null;
  return Math.max(0, Math.min(100, Math.round(x)));
}

function msToIso(ms: unknown): string | null {
  if (typeof ms !== "number" || !Number.isFinite(ms) || ms <= 0) return null;
  return new Date(ms).toISOString();
}

interface ZhipuLimit {
  type?: string;
  unit?: number;
  percentage?: number;
  nextResetTime?: number;
}

interface TierWindow {
  percentage: number | null;
  resetAt: string | null;
}

export interface ParsedTiers {
  fiveHour: TierWindow | null;
  sevenDay: TierWindow | null;
  level: string | null;
}

/**
 * 解析智谱 monitor 响应。
 * unit=3 → fiveHour，unit=6 → sevenDay；unit 缺失按 nextResetTime 升序兜底（近→5h，远→7d）。
 */
export function parseZhipuTiers(data: unknown): ParsedTiers {
  const obj = data as { limits?: ZhipuLimit[]; level?: string } | null;
  const limits = Array.isArray(obj?.limits)
    ? obj.limits.filter((l) => l?.type === "TOKENS_LIMIT")
    : [];

  let fiveHour: TierWindow | null = null;
  let sevenDay: TierWindow | null = null;
  const fallback: Array<{ window: TierWindow; resetRaw: number | null }> = [];

  for (const l of limits) {
    const window: TierWindow = {
      percentage: clampPct(l.percentage),
      resetAt: msToIso(l.nextResetTime),
    };
    if (l.unit === 3) fiveHour = window;
    else if (l.unit === 6) sevenDay = window;
    else fallback.push({ window, resetRaw: l.nextResetTime ?? null });
  }

  if (fallback.length > 0 && (fiveHour === null || sevenDay === null)) {
    fallback.sort((a, b) => {
      const ra = a.resetRaw ?? Number.POSITIVE_INFINITY;
      const rb = b.resetRaw ?? Number.POSITIVE_INFINITY;
      return ra - rb;
    });
    for (const f of fallback) {
      if (fiveHour === null) fiveHour = f.window;
      else if (sevenDay === null) {
        sevenDay = f.window;
        break;
      }
    }
  }

  const level = typeof obj?.level === "string" ? obj.level : null;
  return { fiveHour, sevenDay, level };
}

/** 调智谱 monitor 接口，返回完整 JSON。超时 / HTTP 非 2xx 抛异常。 */
export async function fetchZhipuQuota(
  host: string,
  apiKey: string,
  opts: { fetch?: typeof fetch; timeoutMs?: number } = {},
): Promise<unknown> {
  const fetchFn = opts.fetch ?? fetch;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? FETCH_TIMEOUT_MS);
  try {
    const resp = await fetchFn(`${host}${QUOTA_PATH}`, {
      headers: {
        Authorization: apiKey,
        "Content-Type": "application/json",
        "Accept-Language": "en-US,en",
      },
      signal: ctrl.signal,
    });
    if (!resp.ok) throw new Error(`zhipu quota http ${resp.status}`);
    return await resp.json();
  } finally {
    clearTimeout(timer);
  }
}

function payloadToUsage(p: GlmQuotaPayload): UsageData {
  return {
    fiveHour: p.fiveHour,
    sevenDay: p.sevenDay,
    fiveHourResetAt: p.fiveHourResetAt ? new Date(p.fiveHourResetAt) : null,
    sevenDayResetAt: p.sevenDayResetAt ? new Date(p.sevenDayResetAt) : null,
    ...(p.level ? { balanceLabel: p.level } : {}),
  };
}

export type ZhipuDeps = {
  fetch?: typeof fetch;
  homeDir: string;
  now: number;
};

/**
 * 智谱配额主入口：缓存新鲜（≤TTL）直接返回；否则 fetch，成功更新缓存；
 * fetch 失败用旧缓存兜底，无旧缓存返回 null。
 */
export async function getZhipuUsage(
  env: NodeJS.ProcessEnv,
  deps: ZhipuDeps,
): Promise<UsageData | null> {
  const { apiKey, host } = getZhipuCredentials(env);
  const cached = readCache(deps.homeDir);

  if (cached && deps.now - cached.savedAt <= GLM_QUOTA_TTL_MS) {
    return payloadToUsage(cached);
  }

  try {
    const json = await fetchZhipuQuota(host, apiKey, { fetch: deps.fetch });
    const tiers = parseZhipuTiers((json as { data?: unknown } | null)?.data);
    const payload: GlmQuotaPayload = {
      fiveHour: tiers.fiveHour?.percentage ?? null,
      sevenDay: tiers.sevenDay?.percentage ?? null,
      fiveHourResetAt: tiers.fiveHour?.resetAt ?? null,
      sevenDayResetAt: tiers.sevenDay?.resetAt ?? null,
      level: tiers.level,
    };
    writeCache(deps.homeDir, payload, deps.now);
    return payloadToUsage(payload);
  } catch {
    return cached ? payloadToUsage(cached) : null;
  }
}
