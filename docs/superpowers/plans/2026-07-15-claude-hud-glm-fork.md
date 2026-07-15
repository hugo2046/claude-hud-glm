# claude-hud-glm Fork Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给 fork 版 claude-hud 加智谱 GLM 配额监控，让 GLM 用户在 HUD 看到 `Usage ██░░ XX% (5h) | ░░ XX% (7d) | <level>`，每台机器零额外配置。

**Architecture:** 数据层加一个智谱 provider（`src/providers/zhipu.ts`）+ 一个 TTL 缓存（`src/glm-quota-cache.ts`），在 `index.ts` usageData 组装段尾部挂一个 hook；渲染层零改动。智谱凭证从 statusLine 继承的 `ANTHROPIC_AUTH_TOKEN` / `ANTHROPIC_BASE_URL` 读，Node 原生 `fetch` 调未公开的 monitor 接口，结果缓存 4 分钟。

**Tech Stack:** TypeScript（strict，ESM/NodeNext），Node ≥18（原生 `fetch`、`node:test`），零运行时依赖。

## Global Constraints

- **Node ≥18**，**零运行时依赖**（用原生 `fetch` + `node:test`，不引 npm 包）
- **TS strict + ESM/NodeNext**：所有相对 import 必须带 `.js` 后缀
- **测试**：`node:test` + `node:assert/strict`，测试文件 `.js`，从 `../dist/` import 编译产物；`npm test` = `npm run build && node --test`
- **安全硬约束**（fork 推公开 GitHub）：代码零硬编码 key；**测试 fixture 全部合成**（禁止粘贴真实 API dump，含 `level:"max"` / 真实 `percentage` / 真实 `nextResetTime`）；文档用占位符；commit 前 secret scan
- **v1 仅智谱个人版**（团队版 org/project 留口不做）
- **复用 `showUsage`**，不新增 config 开关
- **缓存 TTL = 240000ms（4min），fetch 超时 = 5000ms**
- **凭证优先级**：`ZHIPUAI_API_KEY` > `ANTHROPIC_AUTH_TOKEN`；host 从 `ANTHROPIC_BASE_URL` 推导（取 `protocol://host`）
- **monorepo 工作目录**：`/home/user/workspace/claude-hud-glm`；git 身份已配 local（`hugo <shen.lan123@gmail.com>`），commit 结尾 `Co-Authored-By: Hugo <shen.lan123@gmail.com>`

---

## File Structure

| 文件 | 责任 | 动作 |
|------|------|------|
| `src/glm-quota-cache.ts` | 缓存读写 + TTL + 原子写（tmp+rename, 0600） | Create |
| `src/providers/zhipu.ts` | 智谱 provider：检测/凭证/解析/fetch/主入口 | Create |
| `src/index.ts` | `MainDeps` 加 `getZhipuUsage`；:147 后挂智谱 hook | Modify |
| `tests/glm-quota-cache.test.js` | 缓存模块测试 | Create |
| `tests/zhipu.test.js` | provider 测试（纯函数 + mock fetch） | Create |
| `tests/index.test.js` | 加智谱 hook 集成用例 | Modify |
| `.claude-plugin/plugin.json` | name/version/author/homepage/repository | Modify |
| `.claude-plugin/marketplace.json` | name/owner/plugins[0].name/metadata.version | Modify |
| `package.json` | name/version | Modify |
| `README.md` | GLM 支持段 + 安装说明 | Modify |

---

## Task 1: 缓存模块 `src/glm-quota-cache.ts`

**Files:**
- Create: `src/glm-quota-cache.ts`
- Test: `tests/glm-quota-cache.test.js`

**Interfaces:**
- Consumes: `getHudPluginDir(homeDir: string): string` from `./claude-config-dir.js`
- Produces: `readCache(homeDir): CachedQuota | null`（不判 TTL，只判存在/损坏）、`writeCache(homeDir, payload, now): void`、`getCachePath(homeDir): string`、`GLM_QUOTA_TTL_MS = 240_000`、类型 `CachedQuota` / `GlmQuotaPayload`

- [ ] **Step 1: 写 `src/glm-quota-cache.ts`**

```typescript
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
```

- [ ] **Step 2: 写 `tests/glm-quota-cache.test.js`**

```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { readCache, writeCache, getCachePath } from '../dist/glm-quota-cache.js';

async function withHome() {
  const homeDir = await mkdtemp(path.join(tmpdir(), 'glm-quota-test-'));
  return { homeDir, cleanup: () => rm(homeDir, { recursive: true, force: true }) };
}

const PAYLOAD = {
  fiveHour: 42,
  sevenDay: 7,
  fiveHourResetAt: '2026-07-15T07:00:00.000Z',
  sevenDayResetAt: null,
  level: 'test',
};

test('writeCache then readCache returns payload', async () => {
  const { homeDir, cleanup } = await withHome();
  try {
    writeCache(homeDir, PAYLOAD, 1000);
    const cached = readCache(homeDir);
    assert.equal(cached?.fiveHour, 42);
    assert.equal(cached?.level, 'test');
    assert.equal(cached?.savedAt, 1000);
  } finally {
    await cleanup();
  }
});

test('readCache returns null when file missing', async () => {
  const { homeDir, cleanup } = await withHome();
  try {
    assert.equal(readCache(homeDir), null);
  } finally {
    await cleanup();
  }
});

test('readCache returns null on corrupted json', async () => {
  const { homeDir, cleanup } = await withHome();
  try {
    const cachePath = getCachePath(homeDir);
    await mkdir(path.dirname(cachePath), { recursive: true });
    await writeFile(cachePath, 'not json', 'utf8');
    assert.equal(readCache(homeDir), null);
  } finally {
    await cleanup();
  }
});

test('readCache returns null when savedAt missing', async () => {
  const { homeDir, cleanup } = await withHome();
  try {
    const cachePath = getCachePath(homeDir);
    await mkdir(path.dirname(cachePath), { recursive: true });
    await writeFile(cachePath, JSON.stringify({ fiveHour: 1 }), 'utf8');
    assert.equal(readCache(homeDir), null);
  } finally {
    await cleanup();
  }
});

test('writeCache creates file with mode 0600', async () => {
  const { homeDir, cleanup } = await withHome();
  try {
    writeCache(homeDir, PAYLOAD, 1000);
    const st = await stat(getCachePath(homeDir));
    assert.equal(st.mode & 0o777, 0o600);
  } finally {
    await cleanup();
  }
});
```

- [ ] **Step 3: 编译**

Run: `npm run build`
Expected: `tsc` 无错，生成 `dist/glm-quota-cache.js`

- [ ] **Step 4: 跑测试**

Run: `node --test tests/glm-quota-cache.test.js`
Expected: 5 tests pass

- [ ] **Step 5: Commit**

```bash
git add src/glm-quota-cache.ts tests/glm-quota-cache.test.js
git commit -m "feat: 加 glm-quota 缓存模块（TTL 4min，原子写）

Co-Authored-By: Hugo <shen.lan123@gmail.com>"
```

---

## Task 2: 智谱 provider `src/providers/zhipu.ts`

**Files:**
- Create: `src/providers/zhipu.ts`
- Test: `tests/zhipu.test.js`

**Interfaces:**
- Consumes: `readCache` / `writeCache` / `GLM_QUOTA_TTL_MS` / `GlmQuotaPayload` from `../glm-quota-cache.js`；`UsageData` from `../types.js`
- Produces: `isZhipuProvider(env): boolean`、`getZhipuCredentials(env): {apiKey, host}`、`parseZhipuTiers(data): ParsedTiers`、`fetchZhipuQuota(host, apiKey, opts?): Promise<unknown>`、`getZhipuUsage(env, deps: ZhipuDeps): Promise<UsageData | null>`、类型 `ZhipuDeps`

- [ ] **Step 1: 写 `src/providers/zhipu.ts`**

```typescript
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
```

- [ ] **Step 2: 写 `tests/zhipu.test.js`**（纯函数 + mock fetch；fixture 全合成）

```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  isZhipuProvider,
  getZhipuCredentials,
  parseZhipuTiers,
  getZhipuUsage,
} from '../dist/providers/zhipu.js';
import { writeCache, GLM_QUOTA_TTL_MS } from '../dist/glm-quota-cache.js';

const ENV = {
  ANTHROPIC_BASE_URL: 'https://open.bigmodel.cn/api/anthropic',
  ZHIPUAI_API_KEY: 'fake-key-for-test',
};

// 合成 fixture（禁止用真实 dump 的值）
const TIERS_BOTH = {
  data: {
    limits: [
      { type: 'TIME_LIMIT', unit: 5, percentage: 1, nextResetTime: 1800000000000 },
      { type: 'TOKENS_LIMIT', unit: 3, percentage: 55, nextResetTime: 1800000000000 },
      { type: 'TOKENS_LIMIT', unit: 6, percentage: 11, nextResetTime: 1805000000000 },
    ],
    level: 'test',
  },
};

async function withHome() {
  const homeDir = await mkdtemp(path.join(tmpdir(), 'zhipu-test-'));
  return { homeDir, cleanup: () => rm(homeDir, { recursive: true, force: true }) };
}

test('isZhipuProvider: bigmodel.cn / z.ai / proxy / empty', () => {
  assert.equal(isZhipuProvider({ ANTHROPIC_BASE_URL: 'https://open.bigmodel.cn/api/anthropic' }), true);
  assert.equal(isZhipuProvider({ ANTHROPIC_BASE_URL: 'https://api.z.ai/api/anthropic' }), true);
  assert.equal(isZhipuProvider({ ANTHROPIC_BASE_URL: 'https://proxy.example.com' }), false);
  assert.equal(isZhipuProvider({}), false);
});

test('getZhipuCredentials: derives host from base_url', () => {
  const { apiKey, host } = getZhipuCredentials(ENV);
  assert.equal(apiKey, 'fake-key-for-test');
  assert.equal(host, 'https://open.bigmodel.cn');
});

test('getZhipuCredentials: throws on missing key', () => {
  assert.throws(() => getZhipuCredentials({ ANTHROPIC_BASE_URL: 'https://open.bigmodel.cn' }), /api key/);
});

test('getZhipuCredentials: throws on non-zhipu domain', () => {
  assert.throws(
    () => getZhipuCredentials({ ZHIPUAI_API_KEY: 'k', ANTHROPIC_BASE_URL: 'https://proxy.example.com' }),
    /not a zhipu official domain/,
  );
});

test('parseZhipuTiers: unit=3→5h, unit=6→7d, ignores TIME_LIMIT', () => {
  const tiers = parseZhipuTiers(TIERS_BOTH.data);
  assert.equal(tiers.fiveHour.percentage, 55);
  assert.equal(tiers.sevenDay.percentage, 11);
  assert.equal(tiers.level, 'test');
});

test('parseZhipuTiers: empty / no TOKENS_LIMIT → all null', () => {
  const tiers = parseZhipuTiers({ limits: [{ type: 'TIME_LIMIT', unit: 5, percentage: 1 }] });
  assert.equal(tiers.fiveHour, null);
  assert.equal(tiers.sevenDay, null);
  assert.equal(tiers.level, null);
});

test('parseZhipuTiers: unit missing falls back by nextResetTime asc', () => {
  const tiers = parseZhipuTiers({
    limits: [
      { type: 'TOKENS_LIMIT', percentage: 60, nextResetTime: 1805000000000 },
      { type: 'TOKENS_LIMIT', percentage: 30, nextResetTime: 1800000000000 },
    ],
  });
  assert.equal(tiers.fiveHour.percentage, 30);  // 近 → 5h
  assert.equal(tiers.sevenDay.percentage, 60);  // 远 → 7d
});

test('parseZhipuTiers: single tier only fills fiveHour', () => {
  const tiers = parseZhipuTiers({
    limits: [{ type: 'TOKENS_LIMIT', unit: 3, percentage: 42, nextResetTime: 1800000000000 }],
  });
  assert.notEqual(tiers.fiveHour, null);
  assert.equal(tiers.sevenDay, null);
});

test('getZhipuUsage: fresh cache returns cached, no fetch', async () => {
  const { homeDir, cleanup } = await withHome();
  try {
    writeCache(homeDir, { fiveHour: 42, sevenDay: 7, fiveHourResetAt: '2026-07-15T07:00:00.000Z', sevenDayResetAt: null, level: 'test' }, 1000);
    let called = false;
    const usage = await getZhipuUsage(ENV, {
      homeDir,
      now: 1000 + 60_000,
      fetch: async () => { called = true; },
    });
    assert.equal(called, false);
    assert.equal(usage.fiveHour, 42);
    assert.equal(usage.balanceLabel, 'test');
  } finally {
    await cleanup();
  }
});

test('getZhipuUsage: expired cache → fetch, returns fresh + writes cache', async () => {
  const { homeDir, cleanup } = await withHome();
  try {
    writeCache(homeDir, { fiveHour: 1, sevenDay: null, fiveHourResetAt: null, sevenDayResetAt: null, level: null }, 1000);
    const fakeFetch = async () => ({ ok: true, json: async () => TIERS_BOTH });
    const usage = await getZhipuUsage(ENV, {
      homeDir,
      now: 1000 + GLM_QUOTA_TTL_MS + 1,
      fetch: fakeFetch,
    });
    assert.equal(usage.fiveHour, 55);
    assert.equal(usage.balanceLabel, 'test');
  } finally {
    await cleanup();
  }
});

test('getZhipuUsage: fetch failure falls back to stale cache', async () => {
  const { homeDir, cleanup } = await withHome();
  try {
    writeCache(homeDir, { fiveHour: 7, sevenDay: null, fiveHourResetAt: null, sevenDayResetAt: null, level: null }, 1000);
    const failFetch = async () => { throw new Error('network'); };
    const usage = await getZhipuUsage(ENV, {
      homeDir,
      now: 1000 + GLM_QUOTA_TTL_MS + 1,
      fetch: failFetch,
    });
    assert.equal(usage.fiveHour, 7);
  } finally {
    await cleanup();
  }
});

test('getZhipuUsage: no cache + fetch failure → null', async () => {
  const { homeDir, cleanup } = await withHome();
  try {
    const failFetch = async () => { throw new Error('network'); };
    const usage = await getZhipuUsage(ENV, { homeDir, now: 1000, fetch: failFetch });
    assert.equal(usage, null);
  } finally {
    await cleanup();
  }
});
```

- [ ] **Step 3: 编译**

Run: `npm run build`
Expected: 生成 `dist/providers/zhipu.js`

- [ ] **Step 4: 跑测试**

Run: `node --test tests/zhipu.test.js`
Expected: 12 tests pass

- [ ] **Step 5: Commit**

```bash
git add src/providers/zhipu.ts tests/zhipu.test.js
git commit -m "feat: 加智谱 GLM provider（monitor 接口 + 缓存集成）

Co-Authored-By: Hugo <shen.lan123@gmail.com>"
```

---

## Task 3: 接入 `src/index.ts`

**Files:**
- Modify: `src/index.ts`（顶部 import、`MainDeps` 类型、deps 对象、`:147` 后 hook）
- Test: `tests/index.test.js`（加智谱 hook 用例）

**Interfaces:**
- Consumes: `getZhipuUsage(env, deps)` / `isZhipuProvider(env)` from `./providers/zhipu.js`
- Produces: `MainDeps.getZhipuUsage` 字段（供测试注入 mock）

- [ ] **Step 1: 改 `src/index.ts` 顶部 import（:13 后加一行）**

在 `import { getUsageFromExternalSnapshot, writeExternalUsageSnapshot } from "./external-usage.js";` 之后插入：

```typescript
import { getZhipuUsage, isZhipuProvider } from "./providers/zhipu.js";
```

- [ ] **Step 2: `MainDeps` 加字段（:21-39 的类型里，`render` 之前加一行）**

在 `  render: typeof render;` 之前插入：

```typescript
  getZhipuUsage: typeof getZhipuUsage;
```

- [ ] **Step 3: deps 对象绑定（:63-82 的对象里，`render,` 之前加一行）**

在 `    render,` 之前插入：

```typescript
    getZhipuUsage,
```

- [ ] **Step 4: 插入智谱 hook（在 `:147` 即 usageData 组装段右大括号 `}` 之后、`:149` `const extraCmd` 之前）**

```typescript
    if (shouldReadUsage && !usageData && isZhipuProvider(process.env)) {
      usageData = await deps.getZhipuUsage(process.env, { now: deps.now(), homeDir: process.env.HOME ?? "" });
    }
```

> 说明：`homeDir` 传 `process.env.HOME`（statusLine 子进程继承）。`getZhipuUsage` 内部凭证缺失/非智谱会抛错，被 `main` 的 `try/catch`（:192）兜底，不影响其他行。

- [ ] **Step 5: 在 `tests/index.test.js` 末尾加智谱 hook 用例**

先读该文件确认现有 import 与 helper 风格，再加（以下为新增用例，helper 沿用文件现有 `runMain`/`makeStdin` 模式；若名字不同按现有风格调整）：

```javascript
test('智谱环境且 stdin 无 rate_limits 时走 getZhipuUsage', async () => {
  // 用 makeStdin 构造无 rate_limits 的 stdin；process.env 设 bigmodel.cn
  const origBase = process.env.ANTHROPIC_BASE_URL;
  process.env.ANTHROPIC_BASE_URL = 'https://open.bigmodel.cn/api/anthropic';
  try {
    let called = false;
    const ctx = await runMain({
      stdin: makeStdin({ model: { display_name: 'glm-5.2' } }),
      overrides: {
        getZhipuUsage: async () => { called = true; return { fiveHour: 55, sevenDay: 11, fiveHourResetAt: null, sevenDayResetAt: null, balanceLabel: 'test' }; },
        parseTranscript: async () => emptyTranscript,
        countConfigs: async () => ({ claudeMdCount: 0, rulesCount: 0, mcpCount: 0, hooksCount: 0, outputStyle: null }),
        getGitStatus: async () => null,
      },
    });
    assert.equal(called, true);
  } finally {
    process.env.ANTHROPIC_BASE_URL = origBase;
  }
});

test('非智谱环境不走 getZhipuUsage', async () => {
  const origBase = process.env.ANTHROPIC_BASE_URL;
  process.env.ANTHROPIC_BASE_URL = 'https://api.anthropic.com';
  try {
    let called = false;
    await runMain({
      stdin: makeStdin({ model: { display_name: 'claude' } }),
      overrides: {
        getZhipuUsage: async () => { called = true; return null; },
        parseTranscript: async () => emptyTranscript,
        countConfigs: async () => ({ claudeMdCount: 0, rulesCount: 0, mcpCount: 0, hooksCount: 0, outputStyle: null }),
        getGitStatus: async () => null,
      },
    });
    assert.equal(called, false);
  } finally {
    process.env.ANTHROPIC_BASE_URL = origBase;
  }
});
```

> 执行者注意：`runMain` / `makeStdin` / `emptyTranscript` 是该测试文件已有的 helper——先读 `tests/index.test.js` 顶部确认它们的确切名字与签名，按现有用法对齐（本任务只验证"智谱 hook 是否被调用"，复用现有 stub 即可）。若文件没有 `runMain`，照现有用例的 main 调用方式改写。

- [ ] **Step 6: 编译 + 全量测试（确保无回归）**

Run: `npm test`
Expected: 全部 pass（含原有所有测试 + 新增 2 个智谱 hook 用例）

- [ ] **Step 7: Commit**

```bash
git add src/index.ts tests/index.test.js
git commit -m "feat: index.ts 接入智谱 hook（stdin 无 usage 时兜底 GLM 配额）

Co-Authored-By: Hugo <shen.lan123@gmail.com>"
```

---

## Task 4: 元数据 + 分发清单

**Files:**
- Modify: `.claude-plugin/plugin.json`、`.claude-plugin/marketplace.json`、`package.json`、`README.md`

> 无测试（纯元数据）。改完 `npm run build` 确认不破坏构建即可。

- [ ] **Step 1: `package.json`** —— `name` 改 `"claude-hud-glm"`，`version` 从 `"0.4.2"` 改 `"0.4.2-glm.1"`（语义化预发布，区别上游；正式可定 `0.5.0`），`description` 末尾加 `"(GLM fork)"`，`author` 按需，`repository.url` 改 `git+https://github.com/hugo2046/claude-hud-glm.git`，`homepage` 改 `https://github.com/hugo2046/claude-hud-glm#readme`。

- [ ] **Step 2: `.claude-plugin/plugin.json`** —— `name` → `"claude-hud-glm"`；`version` 与 package.json 一致；`author.url` / `homepage` / `repository` 指向 `hugo2046/claude-hud-glm`。

- [ ] **Step 3: `.claude-plugin/marketplace.json`** —— 顶层 `name` 改（如 `"claude-hud-glm"`）；`owner` 改你自己；`plugins[0].name` 改 `"claude-hud-glm"`（与 plugin.json 一致）；`metadata.version` 同步。

- [ ] **Step 4: `README.md`** —— 顶部简介后加一节：

```markdown
## GLM（智谱）配额监控

本 fork 额外支持智谱 GLM 的 5h / 7d token 配额监控。**零额外配置**——只要 Claude Code 已配 GLM（`ANTHROPIC_BASE_URL` 指向 `open.bigmodel.cn` 或 `api.z.ai`，`ANTHROPIC_AUTH_TOKEN` 为智谱 api key），HUD 自动显示：

\`\`\`
Usage ██░░ 12% (5h) | ░░ 3% (7d) | max
\`\`\`

凭证从 Claude Code 环境继承，不落盘、不上传。个人版支持；团队版（需 org/project）暂不支持。

### 安装

\`\`\`bash
/plugin marketplace add hugo2046/claude-hud-glm
/plugin install claude-hud-glm
\`\`\`
```

- [ ] **Step 5: 编译确认**

Run: `npm run build`
Expected: 无错

- [ ] **Step 6: Commit**

```bash
git add .claude-plugin/plugin.json .claude-plugin/marketplace.json package.json README.md
git commit -m "chore: 改名 claude-hud-glm + 分发清单 + README

Co-Authored-By: Hugo <shen.lan123@gmail.com>"
```

---

## Task 5: 本地验证 + 发布 + 拆外挂

**Files:** 无新文件（验证 + 运维）

- [ ] **Step 1: 全量测试 + 覆盖率**

Run: `npm run test:coverage`
Expected: 全绿，新模块有覆盖

- [ ] **Step 2: 发布前 secret scan**

Run:
```bash
rg -E "sk-[A-Za-z0-9]{16,}|gh[opsr]_[A-Za-z0-9]{20,}|AIza[A-Za-z0-9]{20,}|shen\.lan" --hidden -g '!node_modules' -g '!.git' .
```
Expected: 无匹配（除测试里的 `fake-key-for-test` 这种明显占位符）

再确认 git 历史干净：
```bash
git log --all -p | rg -E "sk-[A-Za-z0-9]{16,}|gh[opsr]_[A-Za-z0-9]{20,}" | head
```
Expected: 无输出

- [ ] **Step 3: 本地切到 fork 版 statusLine 验证**

临时改 `~/.claude/settings.json` 的 `statusLine.command`，把 runtime 指向 fork 的 `dist/index.js`：
- 原命令里 `plugin_dir=$(ls -d "${CLAUDE_CONFIG_DIR:-$HOME/.claude}"/plugins/cache/*/claude-hud/*/ ...)` 这段动态查找指向官方 cache；
- 本地验证用**绝对路径直指 fork**：把 `exec "{node}" "${plugin_dir}dist/index.js"` 替换为 `exec "/home/user/miniconda3/bin/node" "/home/user/workspace/claude-hud-glm/dist/index.js"`（验证完再改回）。

重启 Claude Code，确认 HUD 出现 `Usage ██░░ XX% (5h) | ░░ XX% (7d) | <level>`。

- [ ] **Step 4: 回归（非智谱不影响）**

临时把 `ANTHROPIC_BASE_URL` 设为 `https://api.anthropic.com` 跑 statusLine，确认 usage 行走原逻辑、不调智谱、不报错。

- [ ] **Step 5: 发布——打 tag 触发 release workflow**

```bash
git tag v0.4.2-glm.1
git push origin main
git push origin v0.4.2-glm.1
```
`.github/workflows/release.yml` 会自动 build + 发 GitHub release（含 dist）。

- [ ] **Step 6: 另一台 GLM 机器验证一步装**

在另一台配好 GLM 的机器：
```bash
/plugin marketplace add hugo2046/claude-hud-glm
/plugin install claude-hud-glm@claude-hud-glm
```
重启 Claude Code，确认 HUD 显示配额。

- [ ] **Step 7: 拆外挂（fork 验证通过后）**

fork 版装好并确认显示后，清掉之前的外挂方案：
```bash
crontab -l | grep -v zhipu_quota.py | crontab -
rm -rf ~/.claude/plugins/claude-hud/feeder
rm -f ~/.claude/plugins/claude-hud/usage.json
```
（`~/.claude/plugins/claude-hud/config.json` 里的 `externalUsagePath` / `sevenDayThreshold` 可保留无害，也可删除。）

- [ ] **Step 8: 最终 commit（如有遗留改动）**

发布 + 验证过程中若改了 `dist/`（CI 会自动维护）或其他，按需 commit。

---

## Self-Review（写计划后自检）

**1. Spec 覆盖**：
- 显示形态（进度条+等级）→ Task 2 `payloadToUsage` 填 fiveHour/sevenDay + balanceLabel=level ✓
- 硬编码智谱独立文件 → Task 2 `src/providers/zhipu.ts` ✓
- 零依赖原生 fetch → Task 2 `fetchZhipuQuota` ✓
- 缓存 TTL 4min + 原子写 → Task 1 ✓
- index.ts:147 hook + main async await → Task 3 ✓
- 安全（零硬编码/合成 fixture/secret scan）→ Task 2 fixture 全合成 + Task 5 secret scan ✓
- 分发（plugin/marketplace/package/README）→ Task 4 ✓
- 复用 showUsage → Task 3 hook 用 `shouldReadUsage` ✓
- v1 个人版 → Task 2 无 org/project 逻辑 ✓

**2. Placeholder 扫描**：无 TBD/TODO；所有代码块完整；Task 3 测试 helper 注明了"先读现有文件对齐"（因 index.test.js 风格未全读，这是必要的执行提示而非 placeholder）。

**3. 类型一致性**：
- `CachedQuota` / `GlmQuotaPayload` 在 Task 1 定义，Task 2 `getZhipuUsage` 消费 ✓
- `UsageData`（types.ts:81）fiveHourResetAt 是 `Date|null` → `payloadToUsage` 转 `new Date()` ✓
- `getZhipuUsage(env, deps)` 签名 Task 2 定义、Task 3 deps 调用一致 ✓
- `MainDeps.getZhipuUsage` Task 3 加字段，deps 对象绑定 `getZhipuUsage` ✓
