/**
 * 推送审计模块
 *
 * 写入 push_trigger_logs + push_trigger_payloads
 */

import { type Selector } from './selectors';

// 运行时读取
function getConfig() {
  return {
    postgrestUrl: process.env.POSTGREST_URL || '',
    postgrestKey: process.env.POSTGREST_ANON_KEY || '',
  };
}

export interface AuditTriggerRecord {
  txnId: string;
  operator: string;
  workflowId: string;
  selector: Selector;
  groups: number;
  recipients: string[];
  scopeSignatures: string[];
  varCodes: string[];
  skipped: string[];
  deliverMode: 'shadow' | 'live';
}

export interface AuditPayloadRecord {
  txnId: string;
  groupSig: string;
  payload: Record<string, unknown>;
}

/**
 * 写入推送触发日志
 */
export async function auditPushTrigger(record: AuditTriggerRecord): Promise<void> {
  const { postgrestUrl, postgrestKey } = getConfig();
  if (!postgrestUrl || !postgrestKey) return;

  await fetch(`${postgrestUrl}/push_trigger_logs`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${postgrestKey}`,
    },
    body: JSON.stringify({
      txn_id: record.txnId,
      operator: record.operator,
      workflow_id: record.workflowId,
      selector: record.selector,
      groups: record.groups,
      recipients: record.recipients,
      scope_signatures: record.scopeSignatures,
      var_codes: record.varCodes,
      skipped: record.skipped,
      deliver_mode: record.deliverMode,
    }),
  }).catch((err) => {
    console.error('[push] audit trigger failed:', err);
  });
}

/**
 * 写入 payload 快照
 */
export async function auditPushPayload(record: AuditPayloadRecord): Promise<void> {
  const { postgrestUrl, postgrestKey } = getConfig();
  if (!postgrestUrl || !postgrestKey) return;

  await fetch(`${postgrestUrl}/push_trigger_payloads`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${postgrestKey}`,
    },
    body: JSON.stringify({
      txn_id: record.txnId,
      group_sig: record.groupSig,
      payload: record.payload,
    }),
  }).catch((err) => {
    console.error('[push] audit payload failed:', err);
  });
}
