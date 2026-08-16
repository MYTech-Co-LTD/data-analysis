// web/lib/perm-write-close.ts
// W5 写关闭（Task 18 / 迁移 184）：data_permissions DB 级禁写后的管理写路径 409 契约。
// 两层拒绝的 PostgREST 错误体形状：
//   REVOKE 层（web 容器经 PostgREST 走 anon，无写权）→ {"code":"42501","message":"permission denied for table data_permissions"}
//   触发器层（superuser/psql 直写兜底）           → {"code":"P0001","message":"data_permissions frozen (W5 写关闭, ...)"}
import { NextResponse } from 'next/server';

export const PERM_FROZEN_GUIDANCE = '四维授权已上收 Casdoor（W5 写关闭）；临时例外走「例外」tab';

export function isPermFrozenError(errText: string): boolean {
  return /data_permissions frozen|permission denied for (table|relation) data_permissions/i.test(errText);
}

// plan Task 18 Step 5 契约：{ error: 'frozen', guidance: '...' } + 409（不带 ok 字段，与 400/502 区分）
export function permFrozenConflict(): NextResponse {
  return NextResponse.json({ error: 'frozen', guidance: PERM_FROZEN_GUIDANCE }, { status: 409 });
}
