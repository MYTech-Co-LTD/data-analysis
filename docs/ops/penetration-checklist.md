# 权限三层 + Novu 推送中心 渗透验收清单（T1-T11 / plan 收尾 / spec §测试节）

> 状态：**成文 2026-08-16（P0b V3 补位）**。spec 测试节引用的 T1-T11 轮转表本体此前缺失（V3「渗透清单成文」被跳过），本清单按 spec 阶段验收挂钩表（U1-U8）+ 测试节清单逐项回填来源。
> 分级执行规则（spec §测试节）：**BLOCKER 相关出口必做**（T3/T5/T6/T8 挂钩的 BLOCKER）；其余按 T1-T11 轮转表每阶段抽 ≥1 项留痕（S6：防疲劳同时防盲区）。
> 留痕 = 验收时在本文档对应项后记日期+执行人（或 link 到测试/日志证据），不通过必须可发现。

## TL;DR：T1-T11 一览

| # | 名称 | 挂钩阶段 | 攻击面/验证点 | 来源 |
|---|---|---|---|---|
| T1 | push 越权三连 | U6 | 无 configure 建模板 / 无 broadcast 全员 / LLM 手写收件人 selector，三连全拒 | spec 测试节「越权三连拒」+ U6 挂钩 T1 |
| T2 | 引擎四守卫 | U5 | owner 校验 / 就绪暂停 / selector 悬空 / 参照完整性——任一守卫绕过即失败 | spec U5 挂钩 T2 |
| T3 | bridge 桥攻击 | U4 | 伪造 payload（仅持 Novu 凭证）→ `engine_sig` 验签 401；重放（同 token+body 二次）拒；跨 token 移植（tokenA 的 body+sig 打 tokenB 路径）拒 | spec RT-2 + U4 挂钩 T3 |
| T4 | 身份同步 | U1 | 薄同步三动作（provision/assign_role/disable）篡改/绕过；outbox 注入失败可重放；drift 假差异告警 | spec U1 挂钩 T4 |
| T5 | 三角色报表一致 | U2 | CEO/战区总/督导同模板异值+脱敏逐字段一致；报表逻辑与权限 DB 一致 | spec U2 挂钩 T5 |
| T6 | 离职四 sink 收权 | U1/U2 | 离职用户四种收权路径（JWT/权限/Casdoor/订阅）全部走通，无残留访问 | spec U1 挂钩 T6 |
| T7 | 降级自动回退 | U7 | Novu 停机 → 逐组直投同产物（脱敏保留、txnId 一致）；wecom-push 一键回退恢复 | spec 测试节 RT-3 + U7 挂钩 T7 |
| T8 | 密钥轮换 | 全局(P0-V5) | 五把密钥（JWT_SECRET/CASDOOR_CLIENT_SECRET/Novu ApiKey/bridge SecretKey/ENGINE_BRIDGE_SECRET）各含轮换步骤+生效验证+回滚；JWT_SECRET 至少演练一次 | spec §8.2 + P0-V5 |
| T9 | 登录流 CSRF/篡改 | 登录护栏 | OIDC `state` nonce 一次性（idx P0-B1 修复）、redirect_uri 白名单、claims 注入篡改（roles/permissions additive 不覆盖） | P0-B1 修复项补位（V3 原始清单未定义 T9，按安全惯例补） |
| T10 | 迁移幂等 | 每次部署 | `migrate.sh` 全部新迁移重跑第二遍 exit 0 且 no-op（含 DROP IF EXISTS / ON CONFLICT） | spec 测试节「迁移幂等（T10）」 |
| T11 | 限速与配额滥用 | U6 | push API 限速 500 人次/h + 单次上限 50（broadcast 豁免上限仍限速）；超限拒绝不吞 | plan Task 14 限速规格（U6 挂钩 T1、T11 并列） |

## 分级与轮转

- **必做（BLOCKER 出口）**：T3（桥伪造/重放）、T5（三角色一致，U2 切换日）、T6（离职收权，U1 上线日）、T8（轮换演练）。
- **抽做（轮转表，每阶段 ≥1 项）**：其余 T# 按上表挂钩阶段落实，蜜蜂蜇式轮转避免疲劳。

## 已闭环项（修复批覆盖，代码级）

| 项 | 覆盖位置 |
|---|---|
| T1 越权三连拒 | `web/lib/push/__tests__/push-api.test.ts`（三连用例）+ push API `checkPushPerm` |
| T3 伪造 payload → engine_sig 401 | `web/lib/push/bridge-verify.ts`（HMAC_SHA256(txnId+subscriberId+contentDigest)）+ `__tests__/bridge-verify.test.ts`（含跨 token 用例） |
| T3 重放拒 | bridge-verify nonce 缓存（键 `${bridge_token}:${sha256(body)}`，TTL 1h）|
| T9 state CSRF | `functions/wecom-oidc-callback/index.js` STATE_RE 校验 + `casdoor_state_nonce` 一次性 + redirect_uri 白名单 |
| T10 迁移幂等 | 全部新迁移按 MIGRATION_TEMPLATE（DROP IF EXISTS / ON CONFLICT）；177 补 push_settings 与 177_push_require_owner 并存幂等 |
| T2 就绪守卫 | `web/lib/push/guards.ts` isPaused fail-close + run-push.test「paused → 不投递」 |

## 现场必做（真机/部署出口）—— 2026-08-17 更新

- [x] **T4**（2026-08-17 真机）：provisioning JIT 真机（TestLiZhi001 04:30 tick 建户链路）✅；disable 真机（05:00 tick，见 T6）✅；assign_role 通道未启用（Casdoor Roles=0，auto 写入处于「对账告警+人工确认」阶段，PR#36 修外壳 bug 后待角色启用后补真机）。**发现并修复三处断链**（PR#25/#36）：provision 假成功（signupApplication 指向不存在 app + body 判红缺失）、disableUser 从未真正禁用（update-user 形态错）、assignRoles 外壳 bug。outbox 注入失败重放机制真机验证（disable 失败入队路径）。drift 告警待后续阶段。
- [x] **T5**（2026-08-17 真机）：三角色同模板 agent-query 实测——行集嵌套 ChenGe(27)⊆YuShunBin(27，同区)⊆DaXiong(197 全店)✅；列结构一致✅；cost 列脱敏三态铁证（report_brand_metric_gen `CASE WHEN can_cost_visible()`：cost=true→3 行可见 / false→0 / 旧形状令牌→0 fail-close）✅。注：retail_detail 的 cost 列数据源木空（乐檬未回填），DuckDB 面列脱敏暂无数据可验，PG 面已验。
- [x] **T6**（2026-08-17 真机，测试用户 TestLiZhi001 全链路）：四 sink 实测——①web API 面：is_active 软校验即时拒+清 cookie（PR#25 补齐断链：此前 blacklist 零写入方+企微路径不查）+ blacklist 按 sub 拉黑（188 新链路 05:00 tick 真机写入）✅；②推送面：归推送 worker（订阅回收）；③Casdoor disable：真机 isForbidden=t（PR#36 修复后；修复前 update-user 形态错从未真正禁用过）✅；④数据面：get_user_perms 离职→[] deny（189 修复 NOT FOUND 宽松哨兵 ["*"]——agent 面全店洞）；另裁裁决-4：旧视野 JWT 7 天窗口接受（middleware sink① 60s 内拒 web 面）。
- [ ] **T7**：Novu 停机演练——归推送 worker（2026-08-17 分工裁定）
- [ ] **T8**：`ENGINE_BRIDGE_SECRET` 轮换（归推送 worker）；**JWT_SECRET 轮换演练留痕——待低峰窗口（北京 23:00-07:00，runbook 约束，2026-08-17 中午不合规）**
- [ ] **T11**：限速压测——归推送 worker（2026-08-17 分工裁定）
- [x] **T10 现场**（2026-08-17）：migrate.sh 全量重跑幂等验证——发现并修复双阻断缺陷（PR#33）：132 裸 GRANT 已被 138 删除的旧签名（守卫化）+ 190 ON CONFLICT DO NOTHING 遇半途旧行断言挂（改 DO UPDATE 自愈）；修复后 main 管线恢复（PR#33/#34 连续 success）= 全量幂等重跑通过。遗留小职：132 重跑在旧签名存在时仍会 GRANT（无害）；migrate.sh 无水位线设计依赖逐文件幂等（已达成）。