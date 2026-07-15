import { GLM_QUOTA_TTL_MS, readCache, writeCache } from "../glm-quota-cache.js";

const ZHIPU_HOSTS = ["bigmodel.cn", "z.ai"];
const QUOTA_PATH = "/api/monitor/usage/quota/limit";
const FETCH_TIMEOUT_MS = 5_000;

export function isZhipuProvider(env) {
  const base = env.ANTHROPIC_BASE_URL ?? env.ZHIPU_BASE_URL ?? "";
  return ZHIPU_HOSTS.some((h) => base.includes(h));
}

export function getZhipuCredentials(env) {
  const apiKey = env.ZHIPUAI_API_KEY ?? env.ANTHROPIC_AUTH_TOKEN;
  if (!apiKey) {
    throw new Error(
      "zhipu api key not found in env (ZHIPUAI_API_KEY / ANTHROPIC_AUTH_TOKEN)",
    );
  }
  const base = env.ANTHROPIC_BASE_URL ?? env.ZHIPU_BASE_URL;
  let host;
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

function clampPct(x) {
  if (typeof x !== "number" || !Number.isFinite(x)) return null;
  return Math.max(0, Math.min(100, Math.round(x)));
}

function msToIso(ms) {
  if (typeof ms !== "number" || !Number.isFinite(ms) || ms <= 0) return null;
  return new Date(ms).toISOString();
}

export function parseZhipuTiers(data) {
  const obj = data;
  const limits = Array.isArray(obj?.limits)
    ? obj.limits.filter((l) => l?.type === "TOKENS_LIMIT")
    : [];

  let fiveHour = null;
  let sevenDay = null;
  const fallback = [];

  for (const l of limits) {
    const window = { percentage: clampPct(l.percentage), resetAt: msToIso(l.nextResetTime) };
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

export async function fetchZhipuQuota(host, apiKey, opts = {}) {
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

function payloadToUsage(p) {
  return {
    fiveHour: p.fiveHour,
    sevenDay: p.sevenDay,
    fiveHourResetAt: p.fiveHourResetAt ? new Date(p.fiveHourResetAt) : null,
    sevenDayResetAt: p.sevenDayResetAt ? new Date(p.sevenDayResetAt) : null,
    ...(p.level ? { balanceLabel: p.level } : {}),
  };
}

export async function getZhipuUsage(env, deps) {
  const { apiKey, host } = getZhipuCredentials(env);
  const cached = readCache(deps.homeDir);

  if (cached && deps.now - cached.savedAt <= GLM_QUOTA_TTL_MS) {
    return payloadToUsage(cached);
  }

  try {
    const json = await fetchZhipuQuota(host, apiKey, { fetch: deps.fetch });
    const tiers = parseZhipuTiers(json?.data);
    const payload = {
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
