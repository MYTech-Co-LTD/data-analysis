import { describe, it, expect, vi } from 'vitest';
import { bannerKey, uuidFromKey, createBannerStorage, BANNER_PREFIX } from '../banner-storage';

const { s3Instances } = vi.hoisted(() => ({ s3Instances: [] as Array<Record<string, unknown>> }));
vi.mock('@aws-sdk/client-s3', () => {
  class S3Client {
    constructor(cfg: Record<string, unknown>) { s3Instances.push(cfg); }
    send = vi.fn();
  }
  const ok = { $metadata: {} };
  return {
    S3Client,
    PutObjectCommand: class { constructor(public input: Record<string, unknown>) {} },
    GetObjectCommand: class { constructor(public input: Record<string, unknown>) {} },
    ListObjectsV2Command: class { constructor(public input: Record<string, unknown>) {} },
    DeleteObjectCommand: class { constructor(public input: Record<string, unknown>) {} },
    ok,
  };
});

describe('bannerKey/uuidFromKey', () => {
  it('生成与反向解析', () => {
    // 注：fixture 须 ≥8 字符——uuidFromKey 校验 [0-9a-f-]{8,64}（真实 banner uuid 来自 crypto.randomUUID()，36 字符）
    const k = bannerKey('abc-1234');
    expect(k).toBe('push-assets/banner/abc-1234.png');
    expect(uuidFromKey(k)).toBe('abc-1234');
  });
  it('非法键 → null', () => {
    expect(uuidFromKey('push-assets/other/x.png')).toBeNull();
    expect(uuidFromKey('push-assets/banner/x.txt')).toBeNull();
    expect(uuidFromKey(BANNER_PREFIX)).toBeNull();
  });
});

describe('createBannerStorage', () => {
  it('缺 env → null', () => {
    expect(createBannerStorage({})).toBeNull();
    expect(createBannerStorage({ S3_ENDPOINT: 'http://x', OOS_ACCESS_KEY: 'a' })).toBeNull();
  });
  it('env 齐全 → 实例，region/forcePathStyle 正确', () => {
    const s = createBannerStorage({
      S3_ENDPOINT: 'http://xinan-1.zos.ctyun.cn',
      OOS_ACCESS_KEY: 'ak', OOS_SECRET_KEY: 'sk', OOS_BUCKET: 'lemeng-datasource',
    });
    expect(s).not.toBeNull();
    const cfg = s3Instances[0];
    expect(cfg.endpoint).toBe('http://xinan-1.zos.ctyun.cn');
    expect(cfg.region).toBe('xinan-1');
    expect(cfg.forcePathStyle).toBe(true);
  });
});
