# 平台级权限接入 Casdoor casbin + Novu 统一推送中心 · 规格 final

日期：2026-08-15 · 状态：**人已终审批准**（4 项裁决已定，见「已裁决记录」）
来源：spec-draft-v1 + panel(method/contract/feasibility) + redteam 14 条 + synthesis 裁决
关联：[[2026-08-13-permission-refactor-design]]、`docs/architecture.md` §4.2-4.4/§6、`.spec-forge/casbin-novu-review/`（全部过程产物）
D1-D9 全部保留未推翻；D8 按裁决-3 调整为「推迟、过渡防护随引擎首发」，D9 按裁决-1 细化为「高危实查启用」。

---

## 目标

（对应 intent 成功标准 1-5；标准 5 按裁决-2 采 SLO 化口径：存量会话零影响 + 新登录 <2-4h + page 告警。价值排序（user 透镜）：O1 千人千面 > O2 对话自助 > O3/O4 管理效率。）

1. 功能授权进 Casdoor casbin（Permission 三段式），人→角色在 Casdoor 配，通讯录薄同步三动作自动化。
2. Novu 自部署统一推送中心（org=shanhai 山海租户），业务推送统一切换，指标带权限的千人千面渲染。**O1 兑现口径（feasibility F2）**：首期 selector 启用 dept/person 子集（role kind 随 U2 开放，selector 契约不变），O1 三周内兑现的承诺在此口径下成立。
3. push-admin 中文对话自助配置（OpenClaw 插件），统一身份链路（client_credentials + JWKS）。
4. 全部越权面（绕插件直调引擎、LLM 指定收件人、无 broadcast 全员推送、审计快照旁路、服务身份冒充、订阅携带旧授权、Novu 伪造投递）有显式拦截与验证。
5. 报表权限行为零回归（shadow 对账门禁）；Casdoor 故障影响面有诚实、演练过的降级口径。

## 非目标

- 系统告警迁移（留 wecom-notify 不动）；wecom-push 退役（停 cron 不删码）之外不删任何现有通道。
- Novu fork / 自研 provider（chat-webhook 是官方扩展点，源码验证 provider 为编译期静态注册）。
- 行级数据权限进 casbin（casbin 单次判定引擎无 policy→SQL，源码已验证）。
- 不动 RLS / 生成器视图 / DuckDB 权限视图 / claims 八字段 / pgrst_pre_request（执行点零改动边界）。
- 内容多语言；第二系统接入 Novu；买 EE / Novu 云。

## 全局约束

1. **casbin 边界（源码验证）**：casbin 是单次判定引擎、无 policy→SQL——行级数据过滤永不进 IdP；数据范围（门店/品牌/品类/成本）留在本地 `data_permissions`。
2. **门店键铁律**：门店键 = `(system_book_code, branch_num)` 复合或 `branch_number`；禁裸 `branch_num` 做 join/去重/过滤（selector 限组织维前置排除；`push_variables.extra_filter` 写入校验钉死，见组件节 §5.1）。
3. **部署规则（CLAUDE.md）**：web/迁移走 GHA；只改 function 走 SSH 直调 + 清 Deno 缓存；迁移全幂等（MIGRATION_TEMPLATE：DROP+CREATE/ON CONFLICT）；新表须 GRANT + restart postgrest（167 ⑤b 丢授权 403 先例）。
4. **时区（RT-9 定案）**：业务时区 = `Asia/Shanghai` 写死——jobs 注册表 cron、幂等「同日」日界、bridge 时间窗统一，进契约测试。
5. **环境现实（feasibility 核实）**：控制面 `113.249.101.33` 26G 盘现仅 postgres+casdoor 两容器，镜像经天翼云仓搬运（跨境拉取不通）；data 机出口 `113.249.120.84`；单人团队（WIP=1 纪律：任一时刻只有一条轨在主动开发）。
6. **语义层铁律**：生成器零改动；新可推指标 = INSERT `push_variables` 一行；口径复用 `metric_registry`（AST）。

## 架构

### 三层模型：帽子 × 座位 × 口径

```
① 身份层（不动）      Casdoor OIDC（企微 provider）→ wecom_id（JIT 建户）
② 帽子层（改造）      Casdoor：人→角色（UI 人工 + 薄同步 auto，单写者原则）
                      角色×功能资源：data-analysis:<模块>:<动作>（casbin Permission）
③ 座位层（不动）      企微通讯录 → org_departments → org_users.department_ids
④ 口径层（输入源切换）data_permissions（role/dept/user 三类 subject，四维合成）
                      → get_user_perms（PERMS_INPUT 感知读镜像或 role_id）
                      → claims → RLS/视图过滤（执行点零改动）
```

「部门总只看自己部门」= 帽子（角色开字段能力，门店维 NULL=跟随部门）× 座位（部门归属）× 部门行（门店清单）的合成；同一角色无需按战区复制。

### 真相源划分

| 数据 | Source of Truth | 合法写入口 |
|---|---|---|
| 人是谁 | Casdoor | 企微 provider / JIT / 薄同步建户 |
| 人→角色 | **Casdoor** | Casdoor UI（manual）+ 薄同步（auto）；本地写者 U1 起全部收编（组件 §4.5a） |
| 角色×功能授权 | Casdoor Permission | Casdoor UI |
| 人→部门 | 企微通讯录 | 企微后台 |
| 角色/部门/个人→数据范围 | data_permissions | `/admin/permissions` |
| 人→角色（本地视图） | **持久投影**（org_users.role_codes），非真相源 | 只被写穿（登录/薄同步/对账） |

关键裁决：`role_codes` 是持久投影（agent-query/run_push/preview 无会话路径的物理载体，也是「Casdoor 宕机数据面不受影响」的载体）；只有 `role_id` 旧列是过渡列（sunset：U2 验收后两版本内删，发 issue）。

### 推送链路总览

```
触发判定（永在本地：scheduler jobs 注册表 / OpenClaw push-admin）
  → run_push 渲染引擎（web/lib/push/，唯一入口）
      selector 解析 → 悬空守卫 → 存在性守卫 → 数据就绪守卫
      → 逐人实时 get_user_perms（PERMS_INPUT 感知）
      → scope 签名分组（schema 见组件 §5.2a）→ 每组短时 JWT 代签
      → 查语义视图算变量（cost 脱敏）→ NovuGateway.triggerBulk（txnId 贯穿）
  → Novu（控制面，dumb pipe，不反查业务库）
  → chat-webhook → wecom-bridge（双层验签，组件 §5.4a）
  → 企微 App B message/send（共享发送库）
降级：Novu 连续失败 → 自动回退 wecom-notify 直投——走同一引擎渲染产物，只换投递通道
```

### 身份视图一致性总表（RT-13 修订：断言降级为待验证）

| 消费端 | 数据源 | TTL/时效 | 失效方式 |
|---|---|---|---|
| 自签 JWT claims | 登录时 Casdoor roles + get_user_perms | 7 天（D9） | 到期；离职 blacklist by sub（web API 面，错误处理节分层） |
| org_users 镜像 | Casdoor→写穿（Casdoor-first） | 软实时，允许短暂滞后 | drift job 纠正；diff3 24h 告警 |
| casbin Permission（agent 路径） | Casdoor API | 5min 缓存 + stale-while-revalidate | 过期且 Casdoor 不可达 → fail-close+24h stale（错误处理节 §6.1a） |
| OpenClaw 服务 JWT | client_credentials | 短时（60s 刷新） | client 撤销后 ≤60s+token 寿命（**撤销即时性待 P0-V2b 验证**） |
| Novu subscriber | 引擎 upsert | 持久 | 离职动作 delete |
| token_blacklist | 本地 | 即时 | 离职按 sub 拉黑 |

（「Novu API 白名单仅接受 data IP」的**实现载体待 P0-V1b 验证**——CE 是否原生支持 IP allowlist，否则前置 nginx 限流。）

## 组件

### 4.1 角色码契约（P0a 首个迁移，BLOCKER：双键债）

- `roles.code` 加 `UNIQUE NOT NULL` + **命名空间约束 `CHECK (code !~ '^[0-9]+$')`**（RT-14：防 code 与其它角色 `role_id::text` 错映射）。
- 前置步骤 0（S2）：**dump 全员 perms 快照**（含角色/部门贡献分解）作 diff=0 门禁基准。
- `UPDATE data_permissions ... WHERE subject_type='role' AND subject_id = r.role_id::text` → code（幂等）；联动改码（get_user_perms 解析、权限页写入、契约测试键假设）。
- **回滚 = 显式反向迁移脚本**（subject_id 还原 `role_id::text`，幂等、入库、演练一次）——M1：幂等重跑是 no-op 不是回滚，禁用「幂等重跑回滚」表述。
- **中间态钉死（C8）**：P0a 后 role 行按 code 匹配、用户角色仍由 role_id 单值经 roles join 折 code（一处实现）；U2 后才读 role_codes 数组——之间无第三态。
- 门禁：改后逐用户 `get_user_perms` 输出 diff=0。
- 契约测试：`Casdoor roles ⊆ data_permissions role subject_id ∪ {admin}` 双向 diff 空。

### 4.2 镜像表（P0a 只加列不删列）

```sql
ALTER TABLE org_users ADD COLUMN IF NOT EXISTS role_codes TEXT[] DEFAULT '{}';
ALTER TABLE org_users ADD COLUMN IF NOT EXISTS casdoor_writer VARCHAR(10) DEFAULT 'auto'; -- auto|manual（C3：新语义载体，不复用 152 的 role_source）
ALTER TABLE org_users ADD COLUMN IF NOT EXISTS casdoor_synced_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS idx_org_users_active ON org_users(is_active);
-- 明确不执行：DROP COLUMN role_id（回滚路径+shadow 基线双保障，U2 后按 sunset 删）
```

- **C3**：152 已建 `role_source`（本地 role_id 写者语义）保留只读直至 U2；本地页 manual 用户若 Casdoor 无角色 → 不豁免薄同步，进 drift 迁移清单（人工补配）。
- 写入次序 Casdoor-first（outbox 天然支持）；写穿三径：登录/薄同步/对账回写；role_id 双写至 U2 稳定。

### 4.3 多角色 cardinality（冻结进契约测试）

- 数据范围合成 = **UNION**（167「角色∪部门」的自然推广，内核零改动）；`can_see_cost` 沿用任一 true 则 true、user 行显式 false 整体替换。
- UI 字段 = priority 最高角色（平级字母序）；**claims 单值 `role_code` = priority 最高角色 code（C5，钉进 V2 快照）**。
- selector 命中 = 任一角色命中。
- `get_user_perms` 签名冻结单入参，roles 解析内移。

### 4.4 fail-open 语义收紧（BLOCKER：arch R2）

- 登录路径保留宽松（无角色用户有部门基底；未知用户 `["*"]` 兜底保留——避免行为回归，且「无角色」≠「未知用户」）。
- 引擎路径 strict wrapper（新增 RPC，委托同一内核）：**PERMS_INPUT 感知判空**（C2：legacy 模式判「role_id 折 code 后无角色行且无部门基底」；casdoor 模式判「镜像空且无部门基底」；不直读镜像）→ NULL 跳过+审计。
- **RT-12**：空集（四维全空）≠ NULL（未知）；空集组 skip+审计，**skipped 率 >20% → collect_fail 告警**（静默可发现）。
- 与 U2 输入源切换分开——单次切换只动一个变量。

### 4.5 薄同步：单写者、写豁免、outbox 重放、三向对账

- 单写者：`casdoor_writer` 标记（auto=dept_role_mapping 推导写 Casdoor；manual=Casdoor UI 人工→薄同步写豁免，防手工配置橡皮擦）。
- manual 翻转竞态防护：仅当该用户 outbox 清空后 diff 持续 ≥2 对账周期才翻转；对账前先取 outbox 积压清单排除。
- 动作分顺序落地：①离职四 sink 最先；②auto 角色写入先「对账告警+人工确认」两周再自动写；③provisioning 先 JIT+人工配角色，有需求再自动化。
- outbox 重放（幂等键 wecom_id+action+day）；A12 前置门禁：首次全量写入前「mapping 推导 vs 现状人工指定」diff 清单人工逐条确认。
- drift 三向对账（每日 job）：diff1（C−E manual 除外）= Casdoor 手工配置→回写镜像标 manual，永不反向覆盖；diff2（E−C）=写失败→outbox 重放，>48h 页级告警；diff3（C−M）=镜像滞后→回写，24h 未收敛告警（镜像滞后直接影响 run_push 分组正确性）。

### 4.5a 既有本地角色写者收编（C1，单写者原则落地前提）

- `152 refresh_role_assignments()` cron 与 `/api/admin/permissions/users` PUT 是现存活跃写者。
- 处置：①推导逻辑单实现（dept_role_mapping→角色收进 web/lib/sync/ 共享模块，refresh 与薄同步同调，禁双推导引擎）；②**U1 薄同步 auto 写入上线日 = refresh cron 停写日**（同一 PR）；③本地 PUT 的 role 字段 U1 起冻结（页面 role 区只读+引导文案，从 U2 提前到 U1），四维 override 不受影响；④U2 后 role_id sunset 时残余路径一并清除。

### 4.6 离职收权分层（T6 诚实口径）

| 面 | 拦截点 | 时效 |
|---|---|---|
| web API（admin/push） | middleware is_active 软校验 + blacklist by sub | 即时 |
| 推送面 | run_push 存在性守卫 + 订阅 owner 再校验（RT-1） | 即时 |
| Casdoor 新登录 | disable | 即时 |
| 数据面（PostgREST/RLS） | 无（旧 7 天 JWT 继续有效） | 最长 7 天窗口（**裁决-4 已裁：接受**，与现状等价非新债；即时化真执行点为 pgrst_pre_request 扩展，未来需要再做） |

### 4.7 登录链路切换（U2，最高风险，独占窗口）

- `PERMS_INPUT=casdoor|legacy` 配置开关，秒级回滚不发版。
- shadow 门禁：预期差异白名单（drift manual 集派生，逐条人工确认）+ 非预期差异双清零；门禁计时起点 = U1 就绪（判据见实施节）。
- **RT-6**：切换执行瞬间**重跑增量 diff=0**（快照到执行间有人变动即作废重走）；回滚预案含 **Casdoor→legacy 角色回放脚本**。
- callback：roles claim 优先（格式以 V2 结论冻结契约快照）、API 查兜底（>2s 降级本次不带角色+告警）；permissions 数组进 claims（additive，pgrst_pre_request 动态平铺验证安全）。
- requireAdmin 切 claims `data-analysis:admin`；ADMIN_USERIDS P0a 即收敛 `BREAKGLASS_ADMINS` env（默认空）。
- **C4**：visible_panels 单源化= `get_user_perms` 返回结构变更——列入 U2 变更集+契约测试更新+消费方清单（callback/preview/管理页），同一 PR 删旧路径。
- 切换日纪律：非周五非月初；**自动化冒烟清单**（F3：登录/callback/权限页/get_user_perms 抽样四脚本）单人分时执行；Casdoor 停机演练（存量会话正常+探活告警）。

### 4.8 权限页配套（user R1）

用户 tab 增「角色（统一身份平台）」只读列（role_codes + casdoor_synced_at + Casdoor 编辑深链）+ 引导文案 + 排障一页纸（镜像滞后→重新登录；Casdoor 配了没范围→data_permissions 缺 role 行；契约红→角色码漂移）。**C7**：角色面审计缺口显式声明——角色变更审计指向 Casdoor 操作日志，architecture.md §6 相应改写。

### 5.1 push_variables 注册表

结构同草稿（var_code PK / metric_code REFERENCES metric_registry / scope_dim / extra_filter JSONB / unit / enabled）；敏感性读 `cost_sensitive` 单源。**C6**：extra_filter 表注释+写入校验**禁裸 branch_num**（须复合键/branch_number/非门店维）。**C9**：新表 GRANT + restart postgrest 入部署 runbook。

### 5.2 run_push 引擎与十条不变量

流程：selector 解析 → **悬空守卫**（role/dept 引用不存在 → **失败非成功**，0 收件人报错+告警；契约测试加 selector 引用存在性）→ 存在性守卫 → **数据就绪守卫**（RT-10：查指标 `data_ready` 与采集 verified；未就绪延迟 30min 重试，3 次未就绪发提示版或跳过+告警——防早 8 点推未对账数）→ 逐人实时 perms → scope 签名分组 → 每组短时 JWT（≤10min）→ 查语义视图算变量 → bulk trigger（≤100/批）→ 审计。

不变量（代码注释+单测+引擎强制）：
1. 逐人实时 perms——经 `get_user_perms`（PERMS_INPUT 感知），不直读镜像、永不消费 7 天 JWT claims（C2）。
2. 存在性守卫：不在 org_users / is_active=false → 跳过+审计；skipped 率 >20% 告警。
3. 未知用户 fail-close（strict NULL 不进分组+审计）。
4. 成本默认拒绝（仅显式 true 渲染，false 脱敏「（无权限查看）」）。
5. 全局去重（多 selector 命中同一人只收一条）。
6. 变量只来自注册表；selector 只组织维（首期 dept/person，role 随 U2）；extra_filter 门店键约束。
7. **幂等与补发（RT-8）**：txnId 每次触发生成（合法补发=新 txnId）；防重复靠 bridge nonce + Novu subscriber transactionId；**Novu transactionId 粒度纳入 V1 验证**后定去重键。分批失败记断点，重发不重复已成功批。
8. 全员 selector 需 `push:broadcast`（引擎闸兜底，绕插件同样拒）。
9. **订阅触发按 owner 实时再校验（RT-1 Critical）**：定时触发时校验 owner 持 `push:configure`（全员订阅加验 broadcast）且在职；撤权/离职 → 订阅自动暂停（标 paused+告警）。**配置不是会话，撤权必须能收回配置**。
10. **降级路径同不变量（RT-3）**：回退 wecom-notify 投递同一引擎渲染的分组产物（逐组直投），禁止退化单版本摘要。

### 5.2a scope 签名 schema（RT-4，契约级）

```
签名 = 四维 canonical JSON：
  {brands, branch_nums, categories: 各 sort(norm(v))；can_see_cost: bool}
norm：NULL/[] → []；'*' → ['*']（保留全放行原义，不与空集混同）
can_see_cost 必入签名（同四维不同成本权限不得同组）
数组排序 LC_ALL=C 字节序（生成器产物排序先例）
```

### 5.3 审计分级与 correlation id（risk A2）

- `push_trigger_logs` 只存元数据：txnId、触发者、selector 定义、分组数、收件人清单、**scope 签名明文**（explainability 基础）、变量 code 清单、skipped 记录。
- `push_trigger_payloads` 值快照：TTL 7 天；读取需 `push:audit` 且**读取者 scope ⊇ 分组 scope** 过滤，不满足只见哈希；管理页替代查询同带过滤。
- txnId 贯穿：trigger log → Novu payload → bridge 日志 → 降级路径。「触发成功没人收到」三方可拼。

### 5.4 wecom-bridge

- 路径段高熵 token `/api/wecom-bridge/<bridge_token>`（32B，push_subscriber_tokens 映射表）——明文 userid 与 query 都进访问日志；401 不区分「签名错/token 不存在」防枚举。
- 验签按 **V1 实测**的 X-Novu-Signature 构造（先读源码再写实现）；±5min 时间窗；**nonce 键 = (token, body hash)**（RT-11：封跨 token 移植重放），TTL 1h；时区 Asia/Shanghai。
- 发送复用共享 wecom 发送库；企微 60020 → 非 2xx 返 Novu，重试语义 U4 实测写 runbook；bridge 不可用演练（停 web 容器记录 Novu 重试/丢弃行为）入 U4；dev compose 联调先行。

### 5.4a 引擎签名层（RT-2 Critical）

bridge token 与 Novu SecretKey 同存 Novu 侧 = 攻破 Novu 得完整伪造链（可伪造数值钓鱼）。**双层签名**：引擎每条 trigger payload 内嵌 `engine_sig = HMAC-SHA256(txnId + subscriberId + content_digest, ENGINE_BRIDGE_SECRET)`；`ENGINE_BRIDGE_SECRET` 只存 web/bridge 侧（Novu 不知）；bridge 验签顺序：①X-Novu-Signature（Novu 身份）②engine_sig（**引擎身份=伪造链断点**）。攻破 Novu 只能重放历史合法消息（nonce 挡），不能伪造新消息。

### 5.5 Novu 运行安全（发布 gate）

- **容量测算 gate（F5）**：上线前磁盘预算 ≥8G 余量实测 + RAM 实测（栈常驻 2-4G 与 Casdoor 同机）；镜像经天翼云仓逐个搬运。
- mongodb TTL 索引（90d）+ 磁盘水位 80% 告警（盘满前科）；workflow 定义每日 export 落对象存储；**F6 定案**：仅 workflow export（mongodump 仅磁盘充裕时加做，不悬置）。
- 双向白名单写死（Novu 侧载体待 V1b）；tag 固定 + advisory 订阅 + 半年升级评估。
- 探活从 data 侧发起（挂 monitor/probe evaluators）；wireguard 隧道 P0-V4 评估（带截止时点，不可行退双向白名单）。
- 降级：Novu 连续失败 → **自动**回退 wecom-notify（同引擎产物，脚本化+演练）。

### 5.6 共享件与调度

- JWKS 验签件 `web/lib/token-verify.ts`（iss/aud/exp/scope 一处实现，push API 与 agent-query 共用；JWKS 缓存 ≥24h；fail-close 触发=page 告警）。
- wecom 发送库：双运行时副本 + 契约测试 + **导出函数清单 diff 静态检查**（F7）。
- 调度进现有 web/lib/jobs 注册表（scheduler+lock+对账语义），cron 只是 job 配置，禁建第二套调度器。

### 5.7 A6 混淆代理人（服务身份冒充）

1. 爆炸半径限定（client scope 仅 openclaw:query/push，永不含 admin；query 侧仍走请求者 scope，冒充不能提权）。
2. 审计双标识（服务身份+声称 userId）。
3. 异常检测：10min 跨 ≥3 userId → 告警 + **默认拒绝**（RT-14；慢速绕过显式承接受，轮换兜底）。
4. 高危操作（broadcast/含 cost 变量）要求 userId 通讯录 active。
5. secret 不落库不进 git；轮换 runbook（§8.2）。

### 6.1 push-admin 三层鉴权

```
企微用户 → requesterSenderId = wecom_id
  → OpenClaw push-admin 插件（照 data-query-plugin 模式）
      ① 服务身份：client_credentials 短时 JWT（scope: openclaw:push，60s 前置刷新）
      ② 人员身份：body.userId
  → web 内部 push API
      ③ JWKS 验签 → Casdoor Permission 闸（push:configure / push:broadcast）
      → run_push 引擎闸兜底
  → 渲染引擎 → Novu
```

双闸：插件闸（LLM 输出只含工具调用；收件人必须结构化 selector）+ 引擎闸（绕插件直调仍拒）。插件只持 CASDOOR_CLIENT_ID/SECRET，不持 Novu 凭证。push API 鉴权完成前仅内网/测试 token（裸面窗口）。

### 6.2 checkFeaturePerm 单模块

`web/lib/feature-perm.ts` 单函数收口所有功能门禁（禁散落 `userid === '...'`）；P0a 读 claims+BREAKGLASS；U2 后读 claims+casbin 实查。切 casbin 是 1 处切换非 N 处 hunt-and-replace。**RT-7**：JWT_SECRET 自签 admin 的真兜底 = 高危实查——**裁决-1 已裁：启用**（admin/push:broadcast/临时授权类 5min 实查 + fail-close 24h stale，随 U2 生效）。

### 6.3 工具面（6→4）与滥用面控制（risk A10）

| 工具 | 鉴权 |
|---|---|
| `list_push_variables()` | 所有登录用户 |
| `create_push_workflow(名称, 模板描述, 变量)` | `push:configure` |
| `create_push_schedule(workflow, selector, cron)` | `push:configure` |
| `push_now(workflow, selector)` | `push:configure`；全员需 `push:broadcast` |

推迟：`update_push_workflow`（删了重建）、`check_push_status`（先用管理页带 §5.3 过滤）。结构化确认回显（挡 cron 中文歧义）；变量字典优雅降级；限速（**按收件人数计**：如 500 人次/小时，RT-14 封 broadcast 轰炸）+ 单次收件人上限 50 + 新 workflow 首触发先发给自己；模板 ownership + admin 可转移。notify-plugin（系统告警）与 push-admin（业务推送）分界无退役。**S5**：U6 回退补「一键 list+disable 本期 schedule/workflow」脚本并演练。

### 6.4 用户可解释性

推送尾部或管理页外露「本条范围=你的权限范围（战区=西南，含成本）」——权限从管控工具变信任工具（数据基础=scope 签名明文留存）。

## 数据流

### 登录链路（U2 后）

Casdoor OIDC（企微静默/扫码）→ callback 换 userinfo → 拉 roles（claim 优先/API 兜底）→ **登录写穿镜像**（role_codes + casdoor_synced_at）→ get_user_perms（PERMS_INPUT=casdoor 读镜像）→ 自签 JWT（八字段+roles+permissions，7 天）→ claims → RLS/视图（执行点零改动）。

### 推送链路（run_push）

见架构节推送链路总览；分组后每组以该组 claims 签 ≤10min 短时 JWT 查语义视图（RLS 同链路），cost_sensitive × 组 can_see_cost=false → 脱敏；一组一 event bulk trigger（≤100/批），payload 含变量值+txnId+engine_sig。

### 薄同步链路（U1）

企微回调+03:17 全量 → 推导（共享模块单实现）→ Casdoor-first 写（provisioning/auto 角色/disable）→ 写镜像 → 失败入 sync_outbox → 下次先清 outbox；每日 drift 三向对账（diff1/diff2/diff3 语义见组件 §4.5）。

### 降级链路

run_push 检测 Novu 连续失败 → 同引擎渲染产物逐组直投 wecom-notify（带 txnId）→ 企微；不变量 10 适用；演练脚本化。

## 错误处理

### fail 方向总表

| 故障点 | 方向 | 语义 |
|---|---|---|
| strict wrapper 未知用户 | fail-close | NULL → 跳过+审计 |
| Casdoor Permission 查失败（>24h） | fail-close | 高危拒绝+人话提示（§6.1a：stale-while-revalidate ≤24h 宽限+告警） |
| JWKS 拉取失败 | fail-close | agent 链路拒+page 告警 |
| bridge 验签失败 | fail-close | 401 不区分原因防枚举 |
| Casdoor 登录不可达 | 降级 | 新登录不可用（待裁决-2：SLO 化或 break-glass）；存量会话与数据面零影响 |
| 薄同步写 Casdoor 失败 | outbox | 重放非丢弃；>48h 页级告警 |
| 数据未就绪推送 | 延迟重试 | 30min × 3 → 提示版或跳过+告警 |
| selector 悬空 | fail | 0 收件人=失败非成功+告警 |
| skipped 率异常 | 告警 | >20% → collect_fail |
| Novu 连续失败 | 自动降级 | 同引擎产物走 wecom-notify |

### 离职收权分层

见组件 §4.6 表（web API/推送/Casdoor 即时；数据面 7 天窗口默认接受，即时化待裁决-4）。

### 残余风险表（显式承接受）

| # | 残余 | 理由 | 缓解 |
|---|---|---|---|
| R1 | client secret 泄露期内可冒充（受 scope 限；慢速冒充可绕过检测） | client_credentials 本质 | §5.7 检测（默认拒绝）+轮换+审计 |
| R2 | Casdoor 单点：新登录依赖 Casdoor | 全自动切换自锁风险 | **裁决-2 已裁 SLO 化**：存量会话零影响+新登录 <2-4h+page 告警；V6 break-glass best-effort 通过后升冷备 |
| R3 | manual 用户不随 mapping 变更自动更新 | 单写者代价 | 对账 diff 提示人工处理 |
| R4 | 7 天内低危权限变更不即时 | D9 已裁 | 接受；高危轴已裁决启用（裁决-1，随 U2 生效） |
| R5 | 数据面离职 7 天窗口 | §4.6 分层诚实 | 裁决-4 已裁：接受（与现状等价） |
| R6 | Novu CE 固定 tag CVE 不修 | 不 fork 代价（D4/D5） | advisory+反向白名单+引擎签名层+半年评估 |
| R7 | 控制面单机（Casdoor+Novu 同机 26G） | 部署约束 | 容量 gate+TTL+水位+备份+降级演练 |
| R8 | 双源过渡腐烂 | 过渡期必然存在 | role_id sunset 写死（U2 后两版本内删，发 issue）；drift 持续盯 |

### 密钥生命周期（四+1 把钥匙）

| 密钥 | 权限面 | 存储 | 轮换 | 泄露检测 |
|---|---|---|---|---|
| JWT_SECRET | 全身份+数据 claims | web env | 季度（全员重登） | 高危实查兜底（待裁决-1）+登录审计异常（RT-7 修正） |
| CASDOOR_CLIENT_SECRET | 服务身份冒充 | 仅 OpenClaw 配置 | 季度+经手人离职即时 | 跨 userId 异常告警 |
| Novu env ApiKey | 全员钓鱼+数值伪造（RT-2 修正） | 仅 web 容器 env | 半年 | 白名单外来源拒+告警；伪造被 engine_sig 挡 |
| bridge SecretKey | 重放/伪造投递 | Novu+bridge env | 半年 | 401 率突增告警 |
| **ENGINE_BRIDGE_SECRET**（新） | 引擎签名层（伪造链断点） | 仅 web/bridge env | 半年 | bridge 验签失败率突增告警 |

每把「轮换步骤+生效验证+回滚」runbook（P0-V5）；JWT_SECRET 轮换至少演练一次（T8）。

## 测试

（分层按 docs/testing-handbook.md §2；渗透清单 T1-T11 分级执行——BLOCKER 相关各阶段出口必做，其余按 T1-T11 轮转表每阶段抽 ≥1 项留痕（S6，防疲劳同时防盲区）。）

- [ ] M-1 键切换：改前快照 dump 存在，逐用户 `get_user_perms` diff=0（`scripts/` 对账脚本 exit 0）
- [ ] strict wrapper 单测：未知用户 NULL / 空集 skip / 空集≠NULL 三态（本地伪造 claims 参数化）
- [ ] scope 签名契约：四维 canonical JSON + `LC_ALL=C` 排序 + `'*'` 规范化（契约测试红绿）
- [ ] 三角色同模板异值+脱敏：CEO/战区总/督导实测（U5 验收，成功标准 2）
- [ ] 越权三连拒：无 configure 建模板 / 无 broadcast 全员 / LLM 手写收件人（U6 验收）
- [ ] RT-1 订阅回收：撤 owner `push:configure` 后 cron 触发被拒+订阅标 paused（注入式测试）
- [ ] RT-2 伪造链断点：仅持 Novu 凭证伪造 payload → bridge `engine_sig` 验签 401（渗透 T3）
- [ ] RT-3 降级同产物：Novu 故障注入 → wecom-notify 收到逐组渲染内容（脱敏保留、`txnId` 与主路径一致）（T7）
- [ ] 契约测试（挂 jobs/qa，红→collect_fail）：①Casdoor 角色码↔subject_id 双向 diff 空 ②Novu 模板 `{{payload.X}}` ⊆ push_variables.enabled ③selector 引用存在性 ④多角色 UNION+roles claim 格式快照（V2 结论）⑤时区 Asia/Shanghai
- [ ] U2 shadow 门禁：白名单+非预期差异双清零归档；切换瞬间增量 diff=0（RT-6）
- [ ] 迁移幂等（T10）：全部新迁移 `migrate.sh` 重跑第二遍 exit 0 且 no-op
- [ ] 部署契约：新表 GRANT anon/authenticated + restart postgrest 步骤在 runbook（C9）

## 实施阶段与待用户裁决

### 阶段结构（P0 拆分 + 双轨并行，F1/F8）

```
P0a 阻塞推送轨四件（3-4 天）：M-1 键切换（快照/反向脚本/命名空间约束）、
    M-2 镜像列+casdoor_writer+strict wrapper（PERMS_INPUT 感知）、
    BREAKGLASS env 化+checkFeaturePerm 骨架、V1/V2 源码验证（U4/U2 硬前置）
P0b 与推送轨并行不挡下游：V3 渗透清单成文 / V4 隧道评估 / V5 密钥 runbook /
    V6 break-glass 凭证（best-effort，通过后升冷备，不作串行门——F4）
推送轨（O1 ≈3 周，首期 selector=dept/person）：
    U3 Novu 部署（容量测算/TTL/水位/export gate）
    U4 wecom-bridge（双层签名+nonce 含 token，dev 联调）
    U5 变量+引擎（四守卫+十不变量+审计分级）
    S4 早期双跑（shadow 干跑：旧通道真投+新链路落盘不投递，自动 diff；
        故障口径=投递失败 0+内容错误 0+延迟 >5min 0——M2/S7）
身份轨（并行浸泡）：U1 Casdoor 地基+薄同步三动作分顺序+写者收编（§4.5a）+outbox+drift
    就绪判据（S1）：连续 7 天白名单外 diff=0 + outbox 清空 + manual 集稳定
U1 就绪 → U2 登录切换（增量 diff=0 重跑+回放脚本+自动化冒烟清单单人执行）
U6 push-admin（硬依赖=U1+U3/U5；排 U2 后属排期选择——S4，U2 拖期可先行交付 O2）
U7 全量切换 + wecom-push 停 cron 不删码（一键回退）
U8 agent-query token 化（**裁决-3 已裁：推迟独立排期**——D8 调整为「模式由 U6 验证、切换延后」；
    过渡防护（A6 审计异常检测+AGENT_API_KEY 轮换 runbook）随引擎首发，不等 U8）
```

单人全程现实日历 6-10 周（含缓冲）；WIP=1 纪律：任一时刻一条轨主动开发，另一轨只处理 diff 非零告警。

### 阶段验收/回退/渗透挂钩

| 阶段 | 验收 | 回退 | 渗透挂钩 |
|---|---|---|---|
| P0a | 键切换 diff=0；契约绿；strict 单测红转绿；V1/V2 记录成文 | M-1 显式反向迁移脚本（已演练）；strict 默认不接入 | V3 清单 v1 成文 |
| U1 | 三动作各验证一次；outbox 注入失败能重放；drift 注入假差异能告警；写者收编实证（refresh 停写+PUT 冻结） | Casdoor 侧幂等可重放 | T4 身份同步、T6 离职四 sink（分层口径） |
| U3 | trigger API 通；探活从 data 侧红→告警实测；容量测算留痕 | 不切订阅即无影响 | — |
| U4 | 测试 subscriber 企微收消息；重放被拒（含跨 token）；伪造 payload 被引擎签名拒 | dev 联调后再上生产 | T3 桥攻击 |
| U5 | 三角色异值+脱敏；四守卫全绿 | 引擎未接生产订阅 | T2 引擎守卫 |
| S4 | shadow 干跑自动 diff 报告（差异=scope 差异解释项才 pass）；一周零故障（三分计数） | 订阅未切=无影响 | — |
| U2 | shadow 双清零+增量 diff=0；全员登录冒烟；Casdoor 停机演练；T5 三角色报表逐字段一致 | PERMS_INPUT 秒回滚+角色回放脚本 | T5、T7（桌面推演） |
| U6 | 中文建模板→确认回显→即推（发给自己）；越权三连拒；限速实测 | 插件闸停+schedule/workflow 一键 disable 脚本 | T1、T11 |
| U7 | 全部业务订阅走 Novu（txnId 可追）；wecom-push cron 停且旧码在；告警链路未动实证 | wecom-push 一键回 | T7 自动回退演练 |
| U8 | 问数全链路回归；吊销 client ≤60s+token 寿命失效（V2b 结论） | AGENT_API_KEY 降级开关 | T8 密钥轮换 |

第一期已知残留（显式）：ADMIN_USERIDS 已 env 化但 casbin 未切；push API 开发期仅内网；离职 JWT 数据窗口照旧（同现状非新债）；Novu subscriber 离职残留（U1 补 delete 后消除）。

### 已裁决记录（2026-08-15 人终审，4 项全定）

1. **D9 高危实查：启用**——admin/push:broadcast/临时授权类服务端实查（5min 缓存 + fail-close + 24h stale 宽限），随 U2 生效；低危（菜单/只读）维持 7 天随 JWT。
2. **成功标准 5：采 SLO 化修订（b）**——存量会话零影响 + 新登录 <2-4h + page 告警；V6 break-glass 凭证 best-effort 并行验证，通过后再升冷备。
3. **U8 推迟、独立排期**——D8 调整为「模式由 U6 验证、切换延后」；过渡防护（A6 审计异常检测 + AGENT_API_KEY 轮换 runbook）随引擎首发。
4. **数据面离职 7 天窗口：接受**——与现状等价非新债；pgrst_pre_request 扩展留作未来选项。

（原裁决 5 mongodb 备份已定案轻方案（§5.5）；原裁决 6 发送库形态已定案双副本+双检查（§5.6）——均经 panel 建议定默认移出。）

### 架构文档更新（实施前完成，CLAUDE.md 铁律）

§6.1 整体重写（三层+删「自查 org_users」过时表述+薄同步链+break-glass/SLO+审计缺口指认）；§6.2 改写（subject_id=code/镜像定位/UNION/一致性总表）；§6.4 新增 casbin 功能授权层；§4.2 授权步骤改写；§4.3 信任边界加 OpenClaw 链路（JWKS+scopes+降级开关）；§4.4 C4「run_as 三道闸」改 run_push 引擎闸；§7.1 加 wecom-bridge；§7.1.2 加 Casdoor 三动作+subscriber purge+blacklist；§7.4 新增 Novu 推送中心（拓扑/白名单/探活方向/TTL 备份水位/txnId 数据流/引擎签名层）；§九追加已确认决策。

---

程序性说明：D1-D9 保留（D8/D9 按已裁决记录调整）；成功标准 1-5 全部满足（标准 5 采 SLO 化口径）；panel 必须改 9 项 + 红队 Critical 2/High 5 全部落位（对应小节已标 RT/C/M/S/F 编号）；4 项裁决已由人终审定案。回写 `docs/superpowers/specs/2026-08-15-platform-casbin-novu-unified-design.md` 并 commit → writing-plans → orca-sdd。
