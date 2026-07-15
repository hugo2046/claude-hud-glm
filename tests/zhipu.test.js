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

// 合成 fixture（非真实账户数据；key 是占位符）
const ENV = {
  ANTHROPIC_BASE_URL: 'https://open.bigmodel.cn/api/anthropic',
  ZHIPUAI_API_KEY: 'fake-key-for-test',
};

// 合成 monitor 响应（unit=3→5h, unit=6→7d，百分比/时间戳均为编造）
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
