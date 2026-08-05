// web/lib/qa/__tests__/duck.test.ts
// duckQuery 超时参数（Task 3：executeTask 采集后 QA 防挂起持锁）。
// timeoutMs>0 挂 AbortController：fetch 永久挂起 → 超时抛错（不永久持锁）；
// 默认 timeoutMs=0 不设超时（daily cron 全量扫描保留原行为）。
import { describe, it, expect, vi, afterEach } from 'vitest';
import { duckQuery } from '../duck';

function abortError(): Error {
  const e = new Error('Aborted');
  e.name = 'AbortError';
  return e;
}

describe('duckQuery 超时参数（Task 3）', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('timeoutMs>0 + fetch 永久挂起 → 超时抛错（AbortError 转超时消息）', async () => {
    vi.useFakeTimers();
    // stub fetch：监听 signal，abort 时 reject AbortError（模拟真实 fetch 的 abort 行为）
    vi.stubGlobal('fetch', vi.fn((_url: unknown, opts?: RequestInit) => new Promise((_resolve, reject) => {
      opts?.signal?.addEventListener('abort', () => reject(abortError()));
    })));

    const p = duckQuery('http://duckdb:9000', 'key', 'SELECT 1', 100);
    const assertion = expect(p).rejects.toThrow('duckdb query timeout after 100ms');
    await vi.advanceTimersByTimeAsync(100);
    await assertion;
  });

  it('timeoutMs=0（默认）不设超时：正常成功返回', async () => {
    const fetchMock = vi.fn(async (_url: unknown) => new Response(JSON.stringify({ success: true, data: [{ c: 42 }] }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const rows = await duckQuery('http://duckdb:9000', 'key', 'SELECT count(*) AS c FROM x');
    expect(rows).toEqual([{ c: 42 }]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('timeoutMs>0 + 正常返回 → 不抛超时，返回数据', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn(async (_url: unknown) => new Response(JSON.stringify({ success: true, data: [{ v: 7 }] }), { status: 200 })));

    const p = duckQuery('http://duckdb:9000', 'key', 'SELECT 7 AS v', 1000);
    const assertion = expect(p).resolves.toEqual([{ v: 7 }]);
    await vi.advanceTimersByTimeAsync(0);
    await assertion;
  });
});
