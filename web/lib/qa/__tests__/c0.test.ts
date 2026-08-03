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
    expect(C0_EPSILON).toBe(0.1);
  });
});
