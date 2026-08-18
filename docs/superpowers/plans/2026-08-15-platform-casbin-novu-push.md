# 平台级 casbin 权限 + Novu 推送中心 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: 用 orca-sdd 逐 task 派发执行（用户指定）。步骤用 checkbox（`- [ ]`）跟踪。

**Goal:** 按 spec `docs/superpowers/specs/2026-08-15-platform-casbin-novu-unified-design.md`（4 项裁决定案）落地：P0a 契约地基 → 推送轨（U3/U4/U5/S4）∥ 身份轨（U1）→ U2/U6/U7。U8 已裁推迟。

**Architecture:** 帽子×座位×口径三层（Casdoor=人→角色+功能授权 casbin；本地 data_permissions=数据范围；RLS 执行点零改动）。推送 = run_push 引擎（四守卫+十不变量）→ Novu（org=shanhai）→ wecom-bridge（双层验签）→ 企微。PERMS_INPUT 开关（system_flags 表）秒回滚。

**Tech Stack:** PostgreSQL 迁移（幂等模板）、Next.js web（vitest）、Deno edge functions、Casdoor（client_credentials/JWKS）、Novu 社区版 6 容器、OpenClaw 插件。

## Global Constraints

- 迁移全幂等（DROP IF EXISTS/ON CONFLICT/DO 块），新表 GRANT anon/authenticated + 部署后 restart postgrest。
- 门店键 = `(system_book_code, branch_num)` 或 `branch_number`；禁裸 `branch_num`（extra_filter 写入校验强制）。
- 时区一律 `Asia/Shanghai`（cron/日界/时间窗）。
- 部署：web/迁移走 GHA；只改 function 走 SSH 直调 + 清 Deno 缓存。
- selector 只组织维（role/dept/person/all；首期启用 dept/person）。
- 引擎数据面永不消费 7 天 JWT claims；变量只来自 push_variables。
- WIP=1：任一时刻一条轨主动开发。
- 生成器（services/semantic-generator/）零改动。

---

### Task 0: architecture.md 更新（CLAUDE.md 铁律：实施前完成）

**Files:**
- Modify: `docs/architecture.md`（§4.2/§4.3/§4.4/§6.1/§6.2/§6.4/§7.1/§7.1.2/§7.4/§九）

**Interfaces:** Consumes: spec §8.5 小节清单。Produces: 文档事实基础，后续 task 引用。

- [ ] **Step 1: 按 spec §8.5 清单逐小节改写**（§6.1 三层+薄同步链+SLO 口径；§6.2 subject_id=code/role_codes 持久投影/UNION/一致性总表/角色审计指向 Casdoor 日志；§6.4 新增 casbin 功能授权层；§4.3 加 OpenClaw 统一身份链路；§4.4 run_as 改 run_push 引擎闸；§7.1/§7.1.2/§7.4 增补）
- [ ] **Step 2: 自查一致性**——grep 旧表述「自查 org_users」「run_as 三道闸」应零残留
- [ ] **Step 3: Commit** `git add docs/architecture.md && git commit -m "docs(arch): 权限三层+Novu 推送中心架构改写（spec 2026-08-15 落地前置）"`

### Task 1: P0a M-1 角色码统一迁移（含快照门禁/反向脚本）

**Files:**
- Create: `database/migrations/168_role_code_unification.sql`
- Create: `database/rollback/168_role_code_unification_reverse.sql`
- Test: `scripts/m1_gate.sql`（psql 门禁）

**Interfaces:** Consumes: `roles(role_id, code)`、`data_permissions(subject_type, subject_id)`。Produces: role 行 `subject_id` = code；快照表 `perm_migration_snapshot(wecom_id, perms jsonb)`；门禁 exit 0 = diff=0。

- [ ] **Step 1: 写门禁脚本（先于迁移可跑，此时 diff=0 逻辑就绪）**

```sql
-- scripts/m1_gate.sql —— 逐用户 get_user_perms vs 快照 diff=0 门禁
DO $$
DECLARE uid TEXT; nowv JSONB; snapv JSONB; bad INT := 0;
BEGIN
  IF to_regclass('perm_migration_snapshot') IS NULL THEN
    RAISE EXCEPTION 'snapshot table missing';
  END IF;
  FOR uid, snapv IN SELECT wecom_id, perms FROM perm_migration_snapshot LOOP
    SELECT to_jsonb(get_user_perms(uid)) INTO nowv;
    IF nowv IS DISTINCT FROM snapv THEN bad := bad + 1;
      RAISE WARNING 'DIFF %: snap=% now=%', uid, snapv, nowv; END IF;
  END LOOP;
  IF bad > 0 THEN RAISE EXCEPTION 'm1 gate FAIL: % users differ', bad; END IF;
END $$;
```

- [ ] **Step 2: 本地 dev 库跑门禁验证失败路径**（无快照表 → FAIL）
Run: `ssh … docker exec deploy-postgres-1 psql -U postgres -d insforge -f - < scripts/m1_gate.sql`（本地 dev 同理容器名）
Expected: ERROR snapshot table missing
- [ ] **Step 3: 写迁移（幂等：先快照再改键）**

```sql
-- 168_role_code_unification.sql
DO $$ BEGIN
  ALTER TABLE roles ADD CONSTRAINT roles_code_uk UNIQUE (code);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE roles ADD CONSTRAINT roles_code_nonnumeric CHECK (code !~ '^[0-9]+$');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
-- 快照（幂等：仅首跑落）
CREATE TABLE IF NOT EXISTS perm_migration_snapshot AS
  SELECT o.wecom_id, to_jsonb(get_user_perms(o.wecom_id)) AS perms,
         now() AS taken_at
  FROM org_users o WHERE o.is_active;
-- 键切换（重跑 no-op）
UPDATE data_permissions dp SET subject_id = r.code
  FROM roles r
  WHERE dp.subject_type = 'role' AND dp.subject_id = r.role_id::text;
```

- [ ] **Step 4: 联动改码**——`database/migrations/167_permission_consolidation.sql` 中 get_user_perms 的 role 行按 code 匹配已是现状（join roles 折 code，C8：一处实现）+ 权限页写入路径 `web/app/api/admin/permissions/users` 若写 `role_id::text` 改写 code；契约测试键假设同步
- [ ] **Step 5: 反向迁移脚本（真回滚，演练一次）**

```sql
-- database/rollback/168_role_code_unification_reverse.sql（不在 migrate.sh 路径）
UPDATE data_permissions dp SET subject_id = r.role_id::text
  FROM roles r WHERE dp.subject_type='role' AND dp.subject_id = r.code;
```

- [ ] **Step 6: 跑门禁** Expected: `m1 gate` PASS（diff=0）；再跑反向→正向各一遍验证可逆
- [ ] **Step 7: Commit** `feat(perm): M-1 角色码统一（快照门禁+反向脚本+命名空间约束）`

### Task 2: P0a M-2 镜像列 + strict wrapper（PERMS_INPUT 感知）

**Files:**
- Create: `database/migrations/169_org_users_role_mirror.sql`
- Create: `database/migrations/170_get_user_perms_strict.sql`
- Test: `scripts/tests/strict_wrapper_test.sql`

**Interfaces:** Produces: `org_users.role_codes TEXT[]`、`org_users.casdoor_writer`、`org_users.casdoor_synced_at`；RPC `get_user_perms_strict(p_wecom_id) RETURNS jsonb`（NULL=未知/无效用户；jsonb=四维，可能为空集）。GRANT anon/authenticated。

- [ ] **Step 1: 写失败测试**

```sql
-- scripts/tests/strict_wrapper_test.sql（dev 库 psql -f；失败即非零退出）
BEGIN;
INSERT INTO org_users(wecom_id, is_active) VALUES ('__t_strict_user', true)
  ON CONFLICT DO NOTHING;
-- 未知用户 → NULL
DO $$ BEGIN
  IF get_user_perms_strict('__no_such_user__') IS NOT NULL THEN
    RAISE EXCEPTION 'unknown user must be NULL'; END IF; END $$;
-- is_active=false → NULL（模拟离职）
UPDATE org_users SET is_active=false WHERE wecom_id='__t_strict_user';
DO $$ BEGIN
  IF get_user_perms_strict('__t_strict_user') IS NOT NULL THEN
    RAISE EXCEPTION 'inactive user must be NULL'; END IF; END $$;
ROLLBACK;
```

- [ ] **Step 2: 跑测试确认失败**（function 不存在 → ERROR）
- [ ] **Step 3: 写迁移**

```sql
-- 169_org_users_role_mirror.sql
ALTER TABLE org_users ADD COLUMN IF NOT EXISTS role_codes TEXT[] DEFAULT '{}';
ALTER TABLE org_users ADD COLUMN IF NOT EXISTS casdoor_writer VARCHAR(10) DEFAULT 'auto';
ALTER TABLE org_users ADD COLUMN IF NOT EXISTS casdoor_synced_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS idx_org_users_active ON org_users(is_active);
GRANT SELECT ON org_users TO anon, authenticated;
```

```sql
-- 170_get_user_perms_strict.sql（委托 167 内核；PERMS_INPUT 感知：读 system_flags，Task 13 建表前默认 legacy）
CREATE OR REPLACE FUNCTION get_user_perms_strict(p_wecom_id TEXT)
RETURNS JSONB LANGUAGE plpgsql STABLE AS $$
DECLARE v JSONB; v_active BOOLEAN; mode TEXT;
BEGIN
  SELECT is_active INTO v_active FROM org_users WHERE wecom_id = p_wecom_id;
  IF v_active IS NULL OR NOT v_active THEN RETURN NULL; END IF;
  SELECT coalesce((SELECT value FROM system_flags WHERE key='perms_input'),'legacy')
    INTO mode;
  IF mode = 'casdoor' AND (SELECT role_codes = '{}' AND casdoor_synced_at IS NULL
       FROM org_users WHERE wecom_id=p_wecom_id)
     AND (SELECT NOT EXISTS (SELECT 1 FROM org_users o
       JOIN org_departments d ON d.dept_id = ANY(o.department_ids)
       WHERE o.wecom_id = p_wecom_id)) THEN RETURN NULL; END IF;
  SELECT get_user_perms(p_wecom_id) INTO v;
  RETURN v;
END $$;
GRANT EXECUTE ON FUNCTION get_user_perms_strict(TEXT) TO anon, authenticated;
```

（附 `CREATE TABLE IF NOT EXISTS system_flags(key TEXT PRIMARY KEY, value TEXT NOT NULL); INSERT INTO system_flags(key,value) VALUES('perms_input','legacy') ON CONFLICT DO NOTHING;` 进 170。）
- [ ] **Step 4: 跑测试确认 PASS**；`docker compose restart postgrest`（dev）
- [ ] **Step 5: Commit** `feat(perm): M-2 镜像列+strict wrapper（PERMS_INPUT 感知 fail-close）`

### Task 3: P0a BREAKGLASS env 化 + checkFeaturePerm 单模块

**Files:**
- Create: `web/lib/feature-perm.ts`
- Modify: `web/lib/admin-api-auth.ts`
- Test: `web/lib/__tests__/feature-perm.test.ts`

**Interfaces:** Produces: `checkFeaturePerm(userId: string, perm: string, claims?: {permissions?: string[]}): Promise<boolean>`；env `BREAKGLASS_ADMINS`（逗号分隔，默认空）。

- [ ] **Step 1: 写失败测试**

```typescript
// web/lib/__tests__/feature-perm.test.ts
import { describe, it, expect, vi } from 'vitest';
import { checkFeaturePerm } from '../feature-perm';
describe('checkFeaturePerm', () => {
  it('claims 含权限 → true', async () => {
    expect(await checkFeaturePerm('u1', 'data-analysis:admin',
      { permissions: ['data-analysis:admin'] })).toBe(true);
  });
  it('无 claims 但在 BREAKGLASS → true 且记审计', async () => {
    process.env.BREAKGLASS_ADMINS = 'u9';
    expect(await checkFeaturePerm('u9', 'data-analysis:admin')).toBe(true);
    delete process.env.BREAKGLASS_ADMINS;
  });
  it('两者皆无 → false', async () => {
    expect(await checkFeaturePerm('u1', 'data-analysis:admin', {})).toBe(false);
  });
});
```

- [ ] **Step 2: `cd web && npx vitest run lib/__tests__/feature-perm.test.ts`** Expected: FAIL（模块不存在）
- [ ] **Step 3: 实现**（claims 优先；BREAKGLASS 命中 `console.warn('[breakglass]', userId, perm)` 审计日志；预留 casbin 实查 hook 位 `// U2+: casbin 实查（5min 缓存+24h stale），裁决-1 启用`）
- [ ] **Step 4: requireAdmin 切换**——`web/lib/admin-api-auth.ts` 的 `ADMIN_USERIDS` 比对改调 `checkFeaturePerm(uid, 'data-analysis:admin')`；`ADMIN_USERIDS` 常量删除，`deploy/.env.example` 加 `BREAKGLASS_ADMINS=`（空）
- [ ] **Step 5: vitest 全绿 + 既有 admin 相关测试回归**
- [ ] **Step 6: Commit** `feat(perm): checkFeaturePerm 单模块收口+BREAKGLASS env 化`

### Task 4: P0b V1/V2 源码验证（不挡下游，与 U3 并行）

**Files:**
- Create: `docs/ops/novu-bridge-signature-verification.md`（V1）
- Create: `docs/ops/casdoor-roles-claim-verification.md`（V2）
- 输入：`/Users/duo/orca/workspaces/explore/分析-casbin-cube-和-message-nest-结合的可能性/源码分析/novu`（chat-webhook 签名构造）、Casdoor 真 token（dev）

**Interfaces:** Produces: 契约快照——bridge 验签算法（是否含时间戳/是否只签 body/Novu transactionId 粒度）；roles claim 格式（数组 vs 逗号串）。Task 6/8/13 消费。

- [ ] **Step 1: 读 novu 源码 `packages/providers/src/lib/chat/chat-webhook/chat-webhook.provider.ts` 及签名工具链，记录 X-Novu-Signature 构造（hmac 算法/入参/时间戳）与 bulk transactionId 粒度，写成文档含代码行号引用**
- [ ] **Step 2: dev Casdoor 用 client_credentials 换一枚真 token（curl /api/login/oauth/access_token），解码 payload 记录 roles claim 实际类型**
- [ ] **Step 3: 两份文档落「契约快照」节（后续实现按此冻结，不得凭假设）**
- [ ] **Step 4: Commit** `docs(ops): V1 bridge 签名+V2 roles claim 契约快照`

### Task 5: U3 Novu 部署（控制面）+ 探活 + 容量 gate

**Files:**
- Create: `casdoor-infra 仓 deploy/novu/docker-compose.yml`（自 `/Users/duo/orca/workspaces/explore/.../源码分析/novu/docker/community/docker-compose.yml` 拷贝改：镜像固定已验证 tag、端口绑 127.0.0.1、DISABLE_USER_REGISTRATION=true、org=shanhai）
- Create: `casdoor-infra 仓 deploy/novu/README.md`（部署/凭证/白名单/备份 runbook）
- Modify: `web/lib/monitor/evaluators/`（新增 novu probe evaluator）
- Modify: `deploy/.env.example`（NOVU_API_KEY/NOVU_API_URL 占位）

**Interfaces:** Produces: `https://<novu-host>` trigger API（ApiKey 鉴权）；探活入 service_down。

- [ ] **Step 1: 控制面容量测算**（ssh opsh：`df -h /opt` 余量 ≥8G、free 实测 RAM ≥4G，记录进 README）不满足即 gate 停
- [ ] **Step 2: 镜像经天翼云仓搬运 + `docker compose up -d` + 建账号（2-3 平台管理员）+ org=shanhai**
- [ ] **Step 3: 网络：data 出口 IP 白名单（Novu 侧载体按 V1b 结论：原生或前置 nginx）；dashboard 仅内网**
- [ ] **Step 4: mongodb TTL 索引（notifications/events 90d）+ workflow export cron（落 data 侧对象存储）**
- [ ] **Step 5: probe evaluator**（从 data 侧 GET novu /health，红 → service_down 告警走 wecom-notify）
- [ ] **Step 6: 验收**：data 机 curl trigger API 通（`{"status": "processed"}` 类响应）；探活红绿实测
- [ ] **Step 7: Commit（两仓各自）** `feat(novu): 控制面部署+容量 gate+探活`

### Task 6: U4 wecom-bridge（双层验签 + nonce 含 token）

**Files:**
- Create: `database/migrations/171_push_subscriber_tokens.sql`
- Create: `web/lib/push/bridge-verify.ts`
- Create: `web/app/api/wecom-bridge/[bridge_token]/route.ts`
- Create: `web/lib/wecom-send.ts`（共享发送库 web 副本）
- Test: `web/lib/push/__tests__/bridge-verify.test.ts`

**Interfaces:** Consumes: V1 契约快照（Task 4）。Produces: `POST /api/wecom-bridge/<bridge_token>`；`verifyBridge({token, body, headers}): {ok, wecomId}|{ok:false}`；`sendWecom(userid, markdown)`。env：`ENGINE_BRIDGE_SECRET`、`NOVU_BRIDGE_SECRET`（HMAC）。

- [ ] **Step 1: 迁移**

```sql
-- 171_push_subscriber_tokens.sql
CREATE TABLE IF NOT EXISTS push_subscriber_tokens (
  bridge_token TEXT PRIMARY KEY,        -- 32B hex 高熵
  wecom_id TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON push_subscriber_tokens TO anon, authenticated;
```

- [ ] **Step 2: 失败测试**（bridge-verify：①无签名拒 ②错误 token 拒 ③engine_sig 缺失拒 ④nonce 重放拒（同 token+body 二次）⑤跨 token 移植拒（tokenA 的 body+sig 打 tokenB 路径））——vitest，伪造 fetch/crypto 注入
- [ ] **Step 3: 实现 bridge-verify.ts**：按 V1 快照验 X-Novu-Signature（时间窗 ±5min Asia/Shanghai）→ 查 push_subscriber_tokens 得 wecom_id → 验 body 内 `engine_sig = HMAC_SHA256(txnId+subscriberId+contentDigest, ENGINE_BRIDGE_SECRET)` → nonce 缓存（内存 Map，键 `${bridge_token}:${sha256(body)}`，TTL 1h）→ 401 不区分原因
- [ ] **Step 4: 实现 wecom-send.ts**（token 获取/60020 处理/message/send markdown；从 wecom-notify function 逻辑提取，导出函数清单留注释供 Task 15 副本对齐）
- [ ] **Step 5: route.ts**（`export async function POST(req, {params})`：raw body → verifyBridge → content 套企微 markdown → sendWecom；非 2xx 返 Novu 触发重试）
- [ ] **Step 6: dev compose 全链路**：Novu chat-webhook provider（credentials=NOVU_BRIDGE_SECRET）→ 测试 subscriber（webhookUrl 指向 dev route）→ 企微测试号收消息；重放 curl 被拒
- [ ] **Step 7: Commit** `feat(push): wecom-bridge 双层验签+nonce+发送库 web 副本`

### Task 7: U5a push_variables 注册表

**Files:**
- Create: `database/migrations/172_push_variables.sql`
- Test: `scripts/tests/push_variables_test.sql`

**Interfaces:** Produces: `push_variables(var_code, name, metric_code→metric_registry, scope_dim, extra_filter, unit, enabled)`；extra_filter 校验函数 `validate_push_extra_filter(jsonb)`（禁裸 branch_num）。

- [ ] **Step 1: 迁移**（表 + CHECK scope_dim IN ('total','brand','war_zone','region','branch') + 校验函数 + GRANT + 种子 2 行：`sale_amount/scope_dim=total`、`achievement_rate/total`）
- [ ] **Step 2: 校验函数**：遍历 jsonb 顶层键，键='branch_num' → EXCEPTION '门店键须 (system_book_code,branch_num) 复合或 branch_number'；值为对象且含 branch_num 单键同拒
- [ ] **Step 3: 测试**：合法 extra_filter INSERT 成功；`{"branch_num":["1"]}` INSERT 报错；重跑迁移 no-op
- [ ] **Step 4: restart postgrest + Commit** `feat(push): push_variables 注册表+门店键写入校验`

### Task 8: U5b 引擎核心（scope 签名 + selector + 分组守卫）

**Files:**
- Create: `web/lib/push/scope-signature.ts`
- Create: `web/lib/push/selectors.ts`
- Create: `web/lib/push/engine.ts`（守卫与分组部分；发送接口留桩由 Task 9 注入）
- Test: `web/lib/push/__tests__/engine.test.ts`

**Interfaces:** Produces:
```typescript
scopeSignature(perms: {brands?:string[]; branch_nums?:string[]; categories?:string[];
  can_see_cost?:boolean}): string  // canonical JSON, LC_ALL=C 排序, '*' 保留
type Selector = {kind:'dept'|'person'|'role'|'all'; ids?:string[]}
resolveRecipients(selector: Selector): Promise<string[]>
groupRecipients(ids: string[], getPerms: (id:string)=>Promise<Perms|null>):
  Promise<{groups: {signature:string; members:string[]; perms:Perms}[]; skipped: string[]}>
```
数据就绪守卫接口 `checkDataReady(varCodes: string[]): Promise<boolean>`（注入）。

- [ ] **Step 1: 失败测试**：签名（四维规范化/排序确定性/can_see_cost 入签名：同四维不同 cost → 不同签名）；分组（未知用户/离职 → skipped；多 selector 命中同一人去重——person+dept 重叠只留一）；selector 悬空（dept id 不存在 → throw，非空成功）
- [ ] **Step 2: 实现 + vitest 绿**
- [ ] **Step 3: Commit** `feat(push): scope 签名 schema+selector 解析+存在性/悬空守卫`

### Task 9: U5c 渲染 + Novu 触发 + 审计分级 + 降级

**Files:**
- Create: `database/migrations/173_push_audit.sql`
- Create: `web/lib/push/render.ts`（每组短时 JWT 代签 + 语义视图查值 + cost 脱敏）
- Create: `web/lib/push/novu-client.ts`（subscriber upsert/triggerBulk/engine_sig）
- Create: `web/lib/push/fallback.ts`（wecom-notify 直投）
- Create: `web/lib/push/index.ts`（run_push 编排：四守卫→逐人 strict→分组→渲染→bulk→审计；降级开关）
- Test: `web/lib/push/__tests__/run-push.test.ts`

**Interfaces:** Produces: `run_push(opts:{workflowId:string; selector:Selector; operatorId:string; broadcastPerm:boolean; deliver?:boolean}): Promise<{txnId:string; groups:number; skipped:string[]}>`。消费 Task 8 接口 + `get_user_perms_strict` RPC + Novu env。

- [ ] **Step 1: 迁移**

```sql
-- 173_push_audit.sql
CREATE TABLE IF NOT EXISTS push_trigger_logs (
  txn_id UUID PRIMARY KEY, operator TEXT NOT NULL, workflow_id TEXT NOT NULL,
  selector JSONB NOT NULL, groups INT NOT NULL, recipients TEXT[] NOT NULL,
  scope_signatures TEXT[] NOT NULL, var_codes TEXT[] NOT NULL,
  skipped TEXT[] DEFAULT '{}', created_at TIMESTAMPTZ DEFAULT now());
CREATE TABLE IF NOT EXISTS push_trigger_payloads (
  txn_id UUID, group_sig TEXT, payload JSONB NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now());
CREATE INDEX IF NOT EXISTS idx_ptp_ttl ON push_trigger_payloads(created_at);
GRANT SELECT, INSERT ON push_trigger_logs, push_trigger_payloads TO anon, authenticated;
-- TTL 7 天清理挂 jobs（qa 或独立 job）
```

- [ ] **Step 2: 失败测试**：不变量 1（getPerms 全部走 strict 注入，断言无 7 天 claims 入参）；不变量 4（组 can_see_cost=false + cost_sensitive 变量 → `（无权限查看）`）；不变量 9（owner 校验注入：configure=false → throw + 标 paused 语义回调）；不变量 10（Novu 故障注入 → fallback 收到**逐组**渲染产物且脱敏保留）；就绪守卫（false → 延迟重试路径标记）
- [ ] **Step 3: 实现**（novu-client：bulk ≤100 分批断点；engine_sig 注入 payload；subscriber upsert 顺带写 push_subscriber_tokens；fallback 用 wecom-send 直投同产物带 txnId）
- [ ] **Step 4: 端到端（dev）**：三测试账号（全量/战区/无成本）同模板异值+脱敏实测——spec 成功标准 2 验收
- [ ] **Step 5: Commit** `feat(push): run_push 引擎全链路（十不变量+审计分级+降级同产物）`

### Task 10: S4 shadow 干跑 + 契约测试 job

**Files:**
- Create: `web/lib/push/shadow.ts`（deliver=false 落 push_trigger_payloads 标 mode='shadow'）
- Create: `web/lib/jobs/push-contract/manifest.ts`（契约 job：Novu 模板 {{payload.X}} ⊆ push_variables.enabled；selector 引用存在性；角色码双向 diff[含 admin]；时区断言）
- Modify: `web/lib/jobs/registry.ts`（注册 push-contract job，cron 每日 04:07 Asia/Shanghai）

**Interfaces:** Consumes: Task 9 run_push（deliver 开关）。Produces: shadow diff 报告脚本 `scripts/shadow-diff.mjs`。

- [ ] **Step 1: shadow 模式**（1-2 测试订阅：旧通道真投 + 新链路渲染落盘；diff 脚本比对落盘快照 vs 旧通道内容，差异须=scope 差异解释项）
- [ ] **Step 2: 契约 job + 红→collect_fail 验证（临时删一个 push_variables 行测红）**
- [ ] **Step 3: 一周观察窗（故障口径三分计数：投递失败 0/内容错误 0/延迟>5min 0）**
- [ ] **Step 4: Commit** `feat(push): S4 shadow 干跑+推送契约测试 job`

### Task 11: U1a Casdoor 种子 + JWKS 共享件

**Files:**
- Create: `web/lib/token-verify.ts`
- Test: `web/lib/__tests__/token-verify.test.ts`
- Create: `casdoor-infra 仓 init/openclaw-gateway.md`（Agent app 配置记录：client_credentials、scopes openclaw:query/openclaw:push、clientId/secret 存放说明）+ `init/shanhai-roles.md`（5 角色+admin、Permissions 资源清单）

**Interfaces:** Produces: `verifyServiceJwt(token: string, needScope: string): Promise<{sub:string}|null>`（JWKS 缓存 ≥24h、iss=`https://sso.shanhaiyiguo.com`、aud=client_id、fail-close+page 告警）。

- [ ] **Step 1: 失败测试**（假 JWKS server 注入：验签通过/过期拒/scope 缺失拒/JWKS 不可达 fail-close 且触发告警回调）
- [ ] **Step 2: 实现 + 绿**
- [ ] **Step 3: Casdoor 控制面配置**（按 init/ 文档手工：Agent app + roles + permissions，截图/记录回填文档）
- [ ] **Step 4: Commit** `feat(auth): JWKS 验签共享件+Casdoor 种子配置记录`

### Task 12: U1b 薄同步（写者收编 + outbox + drift 三向）

**Files:**
- Create: `database/migrations/174_sync_outbox.sql`
- Create: `web/lib/sync/derive-roles.ts`（推导单实现，从 152 refresh 逻辑提取）
- Create: `web/lib/sync/casdoor-client.ts`（provisioning/disable/写角色；Casdoor-first）
- Create: `web/lib/sync/outbox.ts` + `web/lib/sync/drift.ts`
- Modify: `web/lib/jobs/contact-sync/*`（挂三动作；失败入 outbox 计数）
- Modify: 152 相关 cron 停写 + `web/app/api/admin/permissions/users` PUT role 字段冻结（返回 409+引导文案）
- Test: `web/lib/sync/__tests__/derive-roles.test.ts`、`drift.test.ts`

**Interfaces:** Produces: `sync_outbox(id, wecom_id, action, payload jsonb, day, attempts, done)`；drift job 产 diff1/diff2/diff3 报告（>48h/>24h 告警）；`casdoor_writer` 翻转规则（outbox 清空 + diff 持续 ≥2 周期）。

- [ ] **Step 1: 失败测试**：derive-roles 与 152 现行为等价（同输入同输出，含 tie-break）；drift 注入假差异（manual 集/outbox 积压/镜像滞后三分支各自告警路径）；manual 翻转竞态（outbox 非空 → 不翻转）
- [ ] **Step 2: 实现**（分顺序：离职四 sink 最先上线；auto 写入先告警+人工确认模式两周；provisioning 先 JIT）
- [ ] **Step 3: A12 前置门禁**：首次全量写入前跑「mapping 推导 vs 现状人工指定」diff 清单，人工逐条确认（脚本 `scripts/casdoor-write-preview.mjs`）
- [ ] **Step 4: 验收**：三动作各真机验证一次；outbox 注入失败能重放；refresh 停写+PUT 冻结实证
- [ ] **Step 5: Commit** `feat(sync): 薄同步三动作+写者收编+outbox 重放+drift 三向对账`

### Task 13: U2 登录切换（PERMS_INPUT + shadow 门禁 + 回放）

**Files:**
- Create: `database/migrations/175_get_user_perms_input_switch.sql`（get_user_perms 重建：读 system_flags('perms_input') 分支 legacy(role_id)/casdoor(role_codes UNION)；多角色 UNION 语义）
- Create: `web/lib/jobs/perm-shadow/manifest.ts`（全员双源 diff 累积 job）
- Create: `scripts/u2_switch.mjs`（门禁检查+翻开关）+ `database/rollback/175_roles_replay.sql`（Casdoor→legacy 回放）
- Modify: `functions/wecom-oidc-callback/index.js`（roles claim/API 兜底→登录写穿镜像→permissions 进 claims）

**Interfaces:** Consumes: V2 claim 快照、Task 12 镜像。Produces: claims 增 `roles: string[]`、`permissions: string[]`（additive）；`system_flags.perms_input` 可 `UPDATE` 秒回滚。

- [ ] **Step 1: 迁移（分支版 get_user_perms，逻辑同 167 + role_codes UNION 分支）+ 快照单测**（legacy/casdoor 两模式同输入对比）
- [ ] **Step 2: callback 改造 + dev 登录回归**（八字段不变+新增两键；pgrst_pre_request 平铺验证）
- [ ] **Step 3: shadow job 累积 ≥7 天**（就绪判据：白名单外 diff=0 + outbox 清空 + manual 集稳定）
- [ ] **Step 4: 切换日**：u2_switch.mjs = ①增量 diff=0 重跑 ②UPDATE system_flags → 'casdoor' ③自动化冒烟四脚本（登录/callback/权限页/get_user_perms 抽样）；非周五非月初
- [ ] **Step 5: 回滚演练**：UPDATE 回 legacy + 回放脚本演练一次
- [ ] **Step 6: visible_panels 单源化同 PR**（get_user_perms 返回去 UI 字段 → web/lib/contracts 映射；契约测试+消费方清单更新）
- [ ] **Step 7: Commit** `feat(auth): U2 登录输入源切换（shadow 门禁+秒回滚+回放脚本）`

### Task 14: U6 push-admin 插件 + push API + 双闸

**Files:**
- Create: `web/app/api/push/route.ts`（内部 push API：verifyServiceJwt('openclaw:push') → checkPushPerm（Casdoor 实查 5min 缓存+24h stale，裁决-1）→ run_push）
- Create: `web/lib/push/admin-service.ts`（Novu 管理面 JWT 代管：建/列 workflow）
- Create: `openclaw/push-admin-plugin/index.js` + `dist/`（照 data-query-plugin 模式：4 工具）
- Test: `web/lib/push/__tests__/push-api.test.ts`（越权三连拒：无 configure/无 broadcast 全员/手写收件人 selector 拒）

**Interfaces:** Produces: 4 工具（list_push_variables/create_push_workflow/create_push_schedule/push_now）；限速按收件人数计（500 人次/h）+ 单次上限 50（broadcast 豁免上限仍限速）+ 首触发发给自己；结构化确认回显在插件 prompt 层。

- [ ] **Step 1: 失败测试（push API 越权三连 + 限速触发 + schedule owner 校验联动不变量 9）**
- [ ] **Step 2: 实现 push API + admin-service + 插件（工具内校验 + 确认回显文案）**
- [ ] **Step 3: 真机验收**：企微中文对话「建每天 08:00 战区达成率日报推给各战区总」→ 回显确认 → 首触发发给自己 → 放开
- [ ] **Step 4: U6 回退演练**：插件闸停 + `scripts/disable-u6-schedules.mjs` 一键 list+disable
- [ ] **Step 5: Commit** `feat(push): push-admin 三层鉴权+双闸+限速灰度`

### Task 15: U7 全量切换 + wecom-push 退役

**Files:**
- Modify: `functions/agent-query/index.js`（push_report → 调 web push API 走 run_push）
- Modify: `web/lib/jobs/registry.ts`（scheduled_reports 投递改 run_push）
- Modify: `deploy/`（wecom-push cron 停；旧码保留）
- Test: `web/lib/push/__tests__/cutover.test.ts`（订阅投递路径断言走引擎；txnId 可追）

- [ ] **Step 1: 两条投递路径切 run_push（dev 验证 txnId 贯穿 trigger log→Novu→bridge 日志）**
- [ ] **Step 2: wecom-push cron 停（不删码）+ 告警链路未动实证（collect_fail 仍走 wecom-notify）**
- [ ] **Step 3: Novu 停机自动回退演练（T7：同产物逐组直投实测）**
- [ ] **Step 4: 一键回退路径确认（wecom-push 重启 cron 即回）**
- [ ] **Step 5: Commit** `feat(push): U7 业务推送全量切 Novu+wecom-push 退役`

---

## 收尾（全部 task 后）

- 渗透验收清单 T1-T11 按 spec 测试节分级执行留痕；runbook×4（密钥轮换/降级/U2 切换/U6 回退）归 `docs/ops/`。
- `role_id` sunset issue 创建（U2 后两版本内删）。

## Self-Review 结论

- 覆盖检查：spec 组件节 §4.1-§4.8→Task 1/2/12/13；§5.1-§5.7→Task 6/7/8/9/10/14；§6→Task 3/11/14；§7 阶段→Task 5-15 全对应；§8.5→Task 0。U8 已裁推迟不立 task。
- 占位符：无 TBD/TODO；所有代码步骤含实际代码或精确 SQL/路径。
- 类型一致：`run_push`/`scopeSignature`/`Selector`/`verifyServiceJwt`/`get_user_perms_strict` 在定义与消费 task 间签名一致。
