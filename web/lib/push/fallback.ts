/**
 * 降级通道：wecom-notify 直投
 *
 * 契约来源：spec §5.2
 * - Novu 不可用时走企业微信应用消息直发
 * - 逐组发送，保留脱敏结果
 * - 消息带 txnId 标记（可追溯）
 */

import { sendWecomMarkdown } from '../wecom-send';
import { type Perms } from './engine';

export interface FallbackGroup {
  signature: string;
  members: string[]; // wecom_id 列表
  perms: Perms;
  rendered: Record<string, string>;
}

export interface FallbackResult {
  total: number;
  sent: number;
  failed: Array<{ wecomId: string; error: string }>;
}

/**
 * 降级直投
 *
 * @param groups 渲染后的分组
 * @param txnId 事务 ID（消息中标记）
 * @param workflowId 工作流 ID（消息标题）
 */
export async function fallbackSend(
  groups: FallbackGroup[],
  txnId: string,
  workflowId: string
): Promise<FallbackResult> {
  const result: FallbackResult = { total: 0, sent: 0, failed: [] };

  for (const group of groups) {
    // 生成 markdown 内容
    const lines: string[] = [];
    for (const [key, value] of Object.entries(group.rendered)) {
      lines.push(`> **${key}**: ${value}`);
    }
    lines.push('');
    lines.push(`> 事务: \`${txnId}\``);
    lines.push(`> 模式: **降级直投**`);
    const content = lines.join('\n');

    for (const wecomId of group.members) {
      result.total++;
      try {
        const sendResult = await sendWecomMarkdown(wecomId, content, workflowId);
        if (sendResult.ok) {
          result.sent++;
        } else {
          result.failed.push({
            wecomId,
            error: sendResult.errmsg || 'send failed',
          });
        }
      } catch (err) {
        result.failed.push({
          wecomId,
          error: err instanceof Error ? err.message : 'unknown',
        });
      }
    }
  }

  return result;
}
