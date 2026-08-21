// 天翼云 OOS（S3 兼容）对象存储客户端——报表横幅 PNG 持久化（架构 §7.4 2026-08-21）。
// 私有桶 + 独立前缀 push-assets/banner/；读回只经签名路由（防爬/防转发）。
// ZOS 兼容：forcePathStyle + region 取 endpoint host 首段（xinan-1）+ v4 签名（SDK 默认）。
// 无完整 env → createBannerStorage 返回 null（调用方跳过，不抛——降级不拒投）。
import { S3Client, PutObjectCommand, GetObjectCommand, ListObjectsV2Command, DeleteObjectCommand } from '@aws-sdk/client-s3';

export const BANNER_PREFIX = 'push-assets/banner/';

export function bannerKey(uuid: string): string {
  return `${BANNER_PREFIX}${uuid}.png`;
}

export function uuidFromKey(key: string): string | null {
  if (!key.startsWith(BANNER_PREFIX) || !key.endsWith('.png')) return null;
  const uuid = key.slice(BANNER_PREFIX.length, -'.png'.length);
  return uuid && /^[0-9a-f-]{8,64}$/.test(uuid) ? uuid : null;
}

export interface BannerStorage {
  put(key: string, body: Buffer, contentType?: string): Promise<void>;
  get(key: string): Promise<Buffer | null>;
  list(prefix: string): Promise<Array<{ key: string; lastModified: Date }>>;
  del(key: string): Promise<void>;
}

export function createBannerStorage(env?: Partial<Record<string, string>>): BannerStorage | null {
  const e = env ?? process.env;
  const endpoint = e.S3_ENDPOINT;
  const accessKeyId = e.OOS_ACCESS_KEY;
  const secretAccessKey = e.OOS_SECRET_KEY;
  const bucket = e.OOS_BUCKET;
  if (!endpoint || !accessKeyId || !secretAccessKey || !bucket) return null;

  const region = new URL(endpoint).hostname.split('.')[0]; // 'xinan-1'
  const client = new S3Client({
    endpoint,
    region,
    forcePathStyle: true,
    credentials: { accessKeyId, secretAccessKey },
  });

  return {
    async put(key, body, contentType = 'image/png') {
      await client.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentType: contentType }));
    },
    async get(key) {
      // 契约：对象不存在返回 null（路由据此 404），不 reject。
      // 天翼云 OOS 对不存在对象 GetObjectCommand 抛 NoSuchKey（$metadata.httpStatusCode=404）——生产实测确认。
      try {
        const r = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
        if (!r.Body) return null;
        const bytes = await r.Body.transformToByteArray();
        return Buffer.from(bytes);
      } catch (e) {
        if ((e as { name?: string; $metadata?: { httpStatusCode?: number } }).name === 'NoSuchKey') return null;
        throw e;
      }
    },
    async list(prefix) {
      const r = await client.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix }));
      return (r.Contents ?? []).map((o) => ({
        key: o.Key ?? '',
        lastModified: o.LastModified ?? new Date(0),
      }));
    },
    async del(key) {
      await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
    },
  };
}
