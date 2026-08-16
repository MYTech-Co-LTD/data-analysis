# IAM data_permissions sunset 回滚演练记录（W6 / Task 20）

> 演练目标：验证 `database/rollback/167_reverse.sql` 在 sunset（迁移 185）后可把
> `data_permissions`（结构 + `perm_freeze_snapshot` 冻结基线数据）完整找回，且
> 全循环（sunset → 回滚 → 复跑 185 恢复 sunset）幂等无残留。
> W6 退出判据之一（plan 2026-08-16 §W6：「167 回滚演练留痕」）。

## 日期

2026-08-16（本地 dev 容器 `deploy-postgres-1`，W6-Task20 实施窗口内）

## 命令与结果（三段）

### ① sunset 终态基线

```bash
docker exec -i deploy-postgres-1 psql -U postgres -d insforge -v ON_ERROR_STOP=1 \
  < database/migrations/185_perm_sunset.sql        # 两遍（幂等验证）
node --test scripts/tests/perm-sunset.test.mjs     # 9/9 PASS
```

结果：`data_permissions` 已删（to_regclass NULL）；`claim_match_or_star(jsonb,text)` 已删；
shadow 双副本已删；`perms_input=casdoor` + `data_permissions_sunset=done` 旗标就位；
快照/哨兵保留（6 行冻结基线）。

### ② 回滚（167_reverse）

```bash
docker exec -i deploy-postgres-1 psql -U postgres -d insforge -v ON_ERROR_STOP=1 \
  < database/rollback/167_reverse.sql
```

结果：
- `NOTICE: 167_reverse: 恢复 6 行（perm_freeze_snapshot 基线）`
- 断言 `SELECT count(*) FROM data_permissions` = **6** = `SELECT count(*) FROM perm_freeze_snapshot`（逐行对上）
- `system_flags` 的 `data_permissions_sunset` 旗标已 DELETE（perm-shadow job 恢复常态）
- 写权限复授（anon/authenticated arwd）+ `trg_dp_write_close` 摘除（本窗口本就无此触发器，skipping 符合预期）
- **幂等重跑**：`NOTICE: 167_reverse: 跳过灌数（表非空或快照缺失）`——不重复灌数

### ③ 复跑 185 恢复 sunset

```bash
docker exec -i deploy-postgres-1 psql -U postgres -d insforge -v ON_ERROR_STOP=1 \
  < database/migrations/185_perm_sunset.sql
node --test scripts/tests/perm-sunset.test.mjs scripts/tests/perm-write-close.test.mjs \
  scripts/tests/rls-branch-policy.test.mjs scripts/tests/exception-rls-union.test.mjs
```

结果：全绿（**23/23 PASS**：sunset 9 + 写关闭守卫 5 + RLS 分支 5 + 例外并集 4）。

## 演练须知（回滚窗口语义）

- 快照未冻结 `expires_at` 列——恢复行一律 `expires_at=NULL`（=永久）。冻结时点后已过期的
  临时授权在回滚后「复活」，如需精确过期语义须在回滚窗口内人工核对 `note`/时效。
- claims/RLS 终版的回滚 = `git revert 185` 后走 GHA（migrate.sh 重跑 179/182/183 过渡版自动还原）；
  本脚本只管表与数据。
- 回滚窗口内下一次全量部署会重放 184（表在 → REVOKE + 触发器重建）与 185（表删 → 重新 sunset），
  即「回滚只在无部署窗口内有效」——紧急回滚须同时冻结部署流水线。

## 附：Step 5 claims 部署改判记录（2026-08-16 实施取证）

按 plan Step 5 对生产执行了 SSH 直调 InsForge PUT（`functions/wecom-oidc-callback/index.bundle.js`），
PUT 回显暴露**关键事实**：

1. **jq 在服务器侧读文件**——PUT body 是服务器上 GHA rsync 的旧版 bundle（pre-Task-11 形态，
   无 buildClaims/data_scope），与当时线上运行代码一致 → 本次 PUT 为**功能零变化的 no-op**
   （仅刷新 updatedAt；已清 Deno 缓存 + restart + curl 验证 400 形状正常，线上健康）。
2. **生产库完全没有 W1-W5**：`temporary_grants`/`scope_match_v2`/`perm_freeze_snapshot` 均
   `to_regclass NULL`、`perms_input=legacy`、deno 48h 日志无 Task-11 代码特征串——
   IAM 标准化（W1-W6）整体在集成分支，**尚未随发布列车上线生产**。
3. 若强推新 claims bundle 上生产：`maps_branch_group`（178）在生产不存在 → expandResult
   `ok:false` → buildClaims 返回 null → **全员登录 503**。故 Step 5 的生产部署**改判为随发布
   列车走**（GHA Step 4 用仓内已提交的重建 bundle 部署），本 task 不单独直发。
4. 契约① live 段同理：client_credentials 属列车侧 Casdoor 应用（服务器现有 `CASDOOR_CLIENT_ID`
   是登录应用，实测 `unsupported_grant_type`）——live 差分在发布窗内跑，本仓测试保留 env 门控
   自动 skip + 纯函数 fixture 段恒可跑（探测器红/绿已验证）。
