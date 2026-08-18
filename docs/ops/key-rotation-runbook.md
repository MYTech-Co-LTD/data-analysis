# 密钥轮换 runbook（T8 / P0-V5 / spec §8.2）

> 状态：**成文 2026-08-16**。每把密钥必须按「轮换步骤 + 生效验证 + 回滚」三段执行（spec P0-V5）；JWT_SECRET 至少演练一次。
> 原则：先备后用——先在备用侧写入新值并验证，再切主用侧；轮换窗口选业务低峰（企微推送 23:00-07:00 免扰）。

## 密钥清单

| 密钥 | 泄露影响 | 存放位置 | 轮换周期 | 轮换触发 |
|---|---|---|---|---|
| JWT_SECRET | 全身份+数据 claims 伪造 | web env（compose） | 季度（全员重登） | 高危实查兜底 |
| CASDOOR_CLIENT_SECRET | 服务身份冒充 | 仅 OpenClaw 配置 | 季度+经手人离职即时 | 跨 userId 异常告警 |
| Novu env ApiKey | 全员钓鱼+数值伪造 | 仅 web 容器 env | 半年 | 白名单外来源拒+告警 |
| bridge SecretKey | 重放/伪造投递 | Novu + bridge env | 半年 | 401 率突增告警 |
| ENGINE_BRIDGE_SECRET | 引擎签名层（伪造链断点） | 仅 web/bridge env | 半年 | bridge 验签失败率突增告警 |

## 通用模板（每把密钥套用）

1. **轮换步骤**：生成新值 → 写入备用侧 → 生效验证（见下）。
2. **生效验证**：旧值失效、新值生效、副作用归零（关键指标：401/验签失败率不突增；无新告警）。
3. **回滚**：写回旧值 + 重放轮换某侧；记录旧值于密钥管理（不留 git）。

## JWT_SECRET（最重，先演练）

- 轮换：生成新 `JWT_SECRET` → 写 `deploy/.env` → `docker compose up -d web`（或 `restart web`）→ **全员重新登录**（旧 JWT 全失效，这是预期行为，需提前企微/RD 周知）。
- 生效验证：`curl https://data.shanhaiyiguo.com/api/health` 200；无鉴权接口 401 数量正常；任一用户重登成功（可自登 CEO 验证）。
- 回滚：写回旧值 + `restart web` → 旧 JWT 重新有效（未过期者免重新登录）。
- ⚠️ 连带：`INSFORGE_API_KEY`/`INSFORGE_ANON_KEY` 若曾回退签名自 JWT_SECRET，轮换后一并更新（InsForge anon JWT 签名与 PostgREST 匹配问题见架构文档记录）。

## ENGINE_BRIDGE_SECRET（引擎签名层）

- 位置：`ENGINE_BRIDGE_SECRET` 由 `web/lib/push/bridge-verify.ts` 读 `process.env`（引擎侧签名同源，见 engine-sig.ts）。
- 轮换：生成新值 → 先写 **bridge 侧**（web 容器 env）→ 立即验证 bridge 验签对新签名可用（发一条测试推送投测试 subscriber 企微收得到）→ 再写 `NOVU_BRIDGE_SECRET`？**否**——注意区分：bridge SecretKey（Novu→bridge webhook 网关侧）与 ENGINE_BRIDGE_SECRET（引擎→bridge 签名层）是两把。ENGINE 轮换只动 web/bridge env，Novu 侧不动。
- 温和轮换（防窗口期全员被拒）：新引擎签名 + bridge 同时收新旧？当前实现单值读 env → 切换有瞬时窗口。做法：低峰先切 bridge 侧（此时旧引擎签名会 401——持续几分钟），立即切引擎侧；或短窗口内禁推（push_settings paused=true 再转）。**建议演练时实测窗口并记录**（T8 留痕）。
- 生效验证：`web/lib/push/__tests__/bridge-verify.test.ts` 本地跑绿（伪造 payload 401 用例）；生产发测试推送。
- 回滚：写回旧值 + restart web/bridge。

## 其余三把（简）

- **CASDOOR_CLIENT_SECRET**：Casdoor 控制面刷新 → OpenClaw Agent app 更新 → 触发一次 OIDC 登录验证。回滚：改回旧值（Casdoor 保留历史值双生效窗口）。
- **Novu ApiKey**：Novu dashboard → Environment Settings → Regenerate；写 web 容器 env → restart → 发一条测试 Novu trigger 验证（`{"status":"processed"}`）。
- **bridge SecretKey**：Novu chat-webhook 渠道 secret 更新 + bridge env 更新，双写后验证重放被拒 + 正常投递各一次；回滚双写旧值。