// web/lib/push/engine-sig.ts
// engine_sig 内层签名 —— 生产端（novu-client）与验证端（bridge-verify）共享的唯一实现。
// Review 修复（B5）：此前两端各自实现且约定不一致（分隔符、摘要长度、入参来源不同），
// 线上恒验签失败；现收敛为单文件，杜绝再次漂移。
//
// 契约：
//   contentDigest(content) = sha256hex(content)（全 64 位）
//   generateEngineSig(txnId, subscriberId, digest) =
//       HMAC-SHA256-hex(`${txnId}:${subscriberId}:${digest}`, ENGINE_BRIDGE_SECRET)
//   digest 覆盖 engine_content（引擎定义的规范内容串，随 payload 透传 Novu）；
//   bridge 用同一内容串重算摘要再验签。
import { createHash, createHmac, timingSafeEqual } from 'crypto';

/** 内容摘要：SHA-256 hex 全 64 位（两端一致） */
export function contentDigest(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

/** 生成 engine_sig（生产端，novu-client 使用） */
export function generateEngineSig(txnId: string, subscriberId: string, digest: string): string {
  const secret = process.env.ENGINE_BRIDGE_SECRET || '';
  if (!secret) throw new Error('ENGINE_BRIDGE_SECRET not set');
  return createHmac('sha256', secret).update(`${txnId}:${subscriberId}:${digest}`).digest('hex');
}

/** 验证 engine_sig（验证端，bridge-verify 使用；constant-time 比较） */
export function verifyEngineSig(
  sig: string,
  txnId: string,
  subscriberId: string,
  digest: string,
  secret: string,
): boolean {
  if (!secret) return false;
  if (!/^[0-9a-f]{64}$/.test(sig)) return false;
  const expected = createHmac('sha256', secret)
    .update(`${txnId}:${subscriberId}:${digest}`)
    .digest('hex');
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
