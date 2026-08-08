import { describe, it, expect } from 'vitest';
import { runC0, C0_EPSILON } from '../c0';
import type { DetailSource } from '../types';

const src = { name: 'retail' } as DetailSource;

describe('runC0', () => {
  it('ok: 库在 ε 带内 → pass，diff=库-源', async () => {
    const r = await runC0(src, '2026-07-28', 100, 100);
    expect(r.status).toBe('pass');
    expect(r.diff).toBe(0);
    expect(r.detail).toBeNull();
    expect(r.check_type).toBe('C0');
    expect(r.check_name).toBe('retail');
  });

  it('missing: 库<源×(1-ε) → fail（缺漏）', async () => {
    const r = await runC0(src, '2026-07-28', 100, 80);
    expect(r.status).toBe('fail');
    expect(r.diff).toBe(-20);
    expect(r.detail![0]).toEqual({ day: '2026-07-28', api: 100, lib: 80, verdict: 'missing' });
  });

  it('zero-lib guard: apiCount=1 且 lib=0（完全未采集）→ fail missing（low=floor(0.9)=0 会滑成 pass 的边界）', async () => {
    const r = await runC0(src, '2026-07-28', 1, 0);
    expect(r.status).toBe('fail');
    expect(r.diff).toBe(-1);
    expect(r.detail![0]).toEqual({ day: '2026-07-28', api: 1, lib: 0, verdict: 'missing' });
  });

  it('dup-suspect: 库>源×(1+ε) → fail（疑重）', async () => {
    const r = await runC0(src, '2026-07-28', 100, 200);
    expect(r.status).toBe('fail');
    expect(r.diff).toBe(100);
    expect(r.detail![0]).toMatchObject({ verdict: 'dup-suspect' });
  });

  it('api-error: 源取数失败(api<0) → error，无法判定', async () => {
    const r = await runC0(src, '2026-07-28', -1, 0);
    expect(r.status).toBe('error');
    expect(r.diff).toBeNull();
    expect(r.detail![0]).toMatchObject({ verdict: 'error' });
    expect(C0_EPSILON).toBe(0);  // 分毫不差：精确匹配
  });

  it('apiFailed: 源 API count 调用失败 → error（网络/鉴权真异常，非数据未到）', async () => {
    const r = await runC0(src, '2026-07-28', -1, 0, { apiFailed: true });
    expect(r.status).toBe('error');
    expect(r.diff).toBeNull();
    expect(r.detail![0]).toMatchObject({ verdict: 'error' });
  });

  it('no-data: 源 API 成功返回 0 + parquet 缺失(libMissing) → no-data（数据未到，独立预警）', async () => {
    const r = await runC0(src, '2026-07-28', 0, 0, { libMissing: true });
    expect(r.status).toBe('no-data');
    expect(r.diff).toBeNull();
    expect(r.detail![0]).toMatchObject({ verdict: 'no-data', day: '2026-07-28', api: 0, lib: 0 });
  });

  it('no-data: libMissing 时即使 api>0（parquet 缺失优先）→ no-data，不算 missing fail', async () => {
    const r = await runC0(src, '2026-07-28', 120, 0, { libMissing: true });
    expect(r.status).toBe('no-data');
    expect(r.diff).toBeNull();
    expect(r.detail![0]).toMatchObject({ verdict: 'no-data' });
  });

  it('apiFailed 优先于 libMissing：源取数失败且 parquet 缺失 → error（真异常优先）', async () => {
    const r = await runC0(src, '2026-07-28', -1, 0, { apiFailed: true, libMissing: true });
    expect(r.status).toBe('error');
    expect(r.detail![0]).toMatchObject({ verdict: 'error' });
  });

  it('missing: 库比源少 1 行也 fail（分毫不差）', async () => {
    const r = await runC0(src, '2026-07-28', 100, 99);
    expect(r.status).toBe('fail');
    expect(r.diff).toBe(-1);
    expect(r.detail![0]).toMatchObject({ verdict: 'missing' });
  });

  it('字符串 api（lemeng 返字符串 count）与数字 lib 相等 → pass（强转）', async () => {
    const r = await runC0(src, '2026-07-28', '12496', 12496);
    expect(r.status).toBe('pass');
    expect(r.diff).toBe(0);
    expect(r.detail).toBeNull();
  });
});

  it('coarse + merge-accumulation: lib>api → fail（/merge 累积，增量只追加不删除，parquet>count 必异常）', async () => {
    const r = await runC0(src, '2026-08-08', 14762, 14792, { coarse: true });
    expect(r.status).toBe('fail');
    expect(r.diff).toBe(30);
    expect((r.detail as any[])[0].verdict).toBe('merge-accumulation');
  });

  it('coarse 正常增量: lib<api（还没追完）→ pass（不误报）', async () => {
    const r = await runC0(src, '2026-08-08', 10000, 9000, { coarse: true });
    expect(r.status).toBe('pass');
  });
