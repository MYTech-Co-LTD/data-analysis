# U2 登录输入源切换 runbook（T5 / plan Task 13 / spec U2 挂钩）

> 状态：**成文 2026-08-16；未执行**（当前 `system_flags.perms_input = 'legacy'`，U2 未切换）。切换日单人执行。
> 就绪判据（spec S1）：连续 ≥7 天白名单外 shadow diff=0 + outbox 清空 + manual 集稳定。
> 切换约束：**非周五非月初**（spec）；秒回滚保证 = `UPDATE system_flags` 一行 + 回放脚本。

## 前置（切 T-1 天）

- [ ] 停机演练：Casdoor 服务停机一次（模拟），确认 legacy 兜底路径仍可登录（或记录降级行为）。
- [ ] 回放脚本演练：`database/rollback/175_roles_replay.sql` 在 dev 库跑一遍（Casdoor→legacy 回放），留痕。
- [ ] T5 基线：CEO/战区总/督导三账号在 legacy 下取 `get_user_perms` 快照存档。

## 切换执行（scripts/u2_switch.mjs）

1. **门禁 dry-run**：`node scripts/u2_switch.mjs --dry-run`
   - 断言：最近 24h shadow diff=0；连续 ≥7 天无 diff（perm_shadow_log 核查）；outbox 清空（sync_outbox done=true 全覆盖）；manual 集稳定（当日无变更）。
   - 任一不过 → **本次不切**，回到观察窗。
2. **翻转**：`node scripts/u2_switch.mjs`（内部 `UPDATE system_flags SET value='casdoor' WHERE key='perms_input'`）
3. **冒烟四脚本**（u2_switch.mjs 内置）：
   - OIDC 登录一次（roles/permissions 进 claims，additive 断言）
   - callback 路径：八字段不变 + 新增 roles/permissions 两键（pgrst_pre_request 平铺验证）
   - 权限页：get_user_perms 抽样（至少含三账号）与切换前快照 diff=0
   - role_codes 覆盖率：auto 用户 role_codes 非空占比 ≥ 阈值（对照 legacy role_id 覆盖）

## 秒回滚（发现异常立即执行）

```
UPDATE system_flags SET value='legacy' WHERE key='perms_input';
-- 若 Casdoor 侧已写镜像而 legacy 数据被漂移：
psql -f database/rollback/175_roles_replay.sql
```

- 回滚验证：登录恢复 legacy 输入源；get_user_perms 与切换前快照一致；T5 三账号重登核对。
- 回滚后：重启 perm-shadow job（每日 03:30）继续累积 diff，查根因后再排切换。

## 切换后（T+1 天起）

- 观测 7 天：perm_shadow_log 无新增 diff（casdoor/legacy 已同源，应恒 0）；登录失败率 <page 告警阈值。
- U2 稳定后：**role_id sunset 启动**（issue 跟踪）——get_user_perms legacy 分支、refresh_role_assignments、permission 页 role 列，两版本内删除。