# U6 push-admin 回退 runbook（T1 / T11 / plan Task 14 / spec U6 挂钩）

> 状态：**成文 2026-08-16**。U6 push-admin（OpenClaw 插件 + push API）异常时逐级收紧：插件闸停 → 调度 disable → API 层停。整套动作可逆。
> 背景：create_push_schedule 当前**冻结**（U7 定时链路未落地，fail-closed）；push_now 可用。回退主要针对 push_now 与未来 schedule。

## 层级与动作

| 层 | 闸 | 动作 | 可逆 |
|---|---|---|---|
| 1 插件层 | OpenClaw 插件注册 | 停 push-admin 插件（从 OpenClaw agent 配置摘除/禁用）| 重新挂 |
| 2 调度层 | `scheduled_reports.enabled` | `UPDATE scheduled_reports SET enabled=false`（一键脚本/等价 SQL）| `enabled=true` |
| 3 API 层 | push API 鉴权 | verifyServiceJwt('openclaw:push') 签发侧吊销 client（Casdoor client 禁用）→ 全部调用 401 | Casdoor 重启用 |
| 4 引擎层 | `push_settings.is_paused` | `UPDATE push_settings SET is_paused=true` → runPush 拒投（fail-close）| 解暂停 |

## 一键 disable 脚本（T11 演练前置）

plan Task 14 要求 `scripts/disable-u6-schedules.mjs`（list+disable）。当前脚本未落地——回退演练前创建：

```bash
# scripts/disable-u6-schedules.mjs（占位：以实际实现替换）
# node scripts/disable-u6-schedules.mjs        # list：SELECT cron_job_id, workflow_id, enabled FROM scheduled_reports
# node scripts/disable-u6-schedules.mjs --all  # UPDATE scheduled_reports SET enabled=false
```

## 回退触发条件

- 插件产生不当推送（越权/错内容/超限）且无法即时修。
- 越权三连（T1）任一被实网绕过——先 API 层 401 拒，再查鉴权链。
- T11 限速失控（单次 >50 / >500 人次·h）——先 API 层，不必停插件。

## 恢复

- 按层逆序恢复；每层恢复后发一条**发给自己**的测试推送验证（首触发送给自己是 U6 验收项）。
- 恢复前确认根因已封堵（恶意或越权 → 先改代码/权限再放开）。