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

// 合成 fixture（非真实账户数据）
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
