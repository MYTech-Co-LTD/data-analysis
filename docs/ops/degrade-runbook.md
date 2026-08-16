# Novu 降级与自动回退 runbook（T7 / RT-3 / plan Task 15 / spec U7 挂钩）

> 状态：**成文 2026-08-16**（含演练清单，真机演练在 U7 上线日前后执行留痕）。
> 目标：Novu 停机时业务推送不中断——引擎 fallback 逐组直投企微（同产物、脱敏保留、txnId 一致）；故障恢复后 wecom-push 一键回退路径确认（不删旧码）。

## 架构备忘（降级不发生数据丢失的前提）

- 投递路径：run_push → Novu trigger（bulk ≤100 分批）→ bridge webhook → 企微；Novu 故障 → `fallback` 走 `wecom-send` 直投**逐组**渲染产物（脱敏保留、内容与主路径同源，`txnId` 贯穿）。
- fallback 只补**失败批次**的收件人（防重复投递，M8）。
- 就绪守卫：`isPaused` fail-close——暂停时引擎拒绝投递（不是静默丢）。

## Novu 停机检测（信号）

1. 探活红：Novu `/health` 从 data 侧 GET 失败 → service_down 告警（U3 部署的 probe evaluator）。
2. 投递失败突增：bridge 401 率突增告警 或 Novu trigger errors 非零。
3. 恢复判据：探活绿连续 2 周期 + 无失败告警。

## 降级执行（无需人工干预的部分）

- **自动**：triggerBulk 返回 errors → fallback 直投失败批次（引擎内建，无开关）。
- **人工**：若整链发现延迟 >5min（SLO 口径）→ 检查 push_settings：确认 `isPaused` 未被误置 true（暂停会拒绝投递，区分「正常暂停」与「故障」）；逐组直投仍失败 → 降级到 wecom-push 旧链路（见下）。

## 一键回退到 wecom-push（旧链路）

1. **停调度**：`web/lib/jobs/registry.ts` 中按 U7 注册的投递 job 若在跑，先停（registry 内 enabled=false 或暂停 cron）。
2. **起旧链路**：wecom-push cron 未删（U7 只停 cron），重启对应调度即恢复旧投递路径。
3. **验证**：一份已知定时报告正常送达；`collect_fail` 告警链路未动实证（仍走 wecom-notify，不经过 Novu）。

## RT-3 演练（T7 / spec 测试节）

- [ ] 注入 Novu 故障（停 novu-*-1 容器或改 NOVU_API_URL 指向死端口）→ 触发一次 run_push（非 shadow）→ 断言：企微收到**逐组**渲染内容；脱敏保留（cost/profit 变量为「（无权限查看）」当 applicable）；消息内 txnId 与主路径一致（可用 shadow txnId 比对）。
- [ ] 恢复 Novu → 触发同内容 → 不再走 fallback；bridge 验签成功率回到 100%。
- [ ] wecom-push 一键回退实测一次：停新链 → 旧链送达 → 恢复新链（记录命令与耗时）。

## 回滚/恢复清单

| 步骤 | 命令/动作 |
|---|---|
| 停新链投递 | registry 对应 job enabled=false（或 IS PAUSED via push_settings）|
| 起旧链 | wecom-push 重启 cron（旧码保留）|
| 恢复新链 | registry enabled=true + push_settings 解暂停 |
| 验证恢复 | 探活绿 + 一次真实投递成功 + fallbackUsed=false |