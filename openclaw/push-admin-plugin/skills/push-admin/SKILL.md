# Push Admin Skill

推送管理插件使用指南。

## 工具列表

| 工具 | 用途 | 权限 |
|------|------|------|
| `list_push_variables` | 列出可推送的业务变量 | 所有登录用户 |
| `create_push_workflow` | 创建推送模板 | push:configure |
| `create_push_schedule` | 创建定时推送计划 | push:configure（全员需 push:broadcast） |
| `push_now` | 立即触发推送 | push:configure（全员需 push:broadcast） |

## 使用流程

1. **查看变量**：先调 `list_push_variables` 了解有哪些可推送变量
2. **创建模板**：调 `create_push_workflow` 创建推送模板（含变量列表）
3. **触发推送**：
   - 一次性推送：`push_now`（立即发送）
   - 定时推送：`create_push_schedule`（cron 调度）

## Selector 规则

收件人 selector 只接受组织维：
- `{kind: "person", ids: ["ZhangDuo"]}` — 指定个人
- `{kind: "dept", ids: ["dept_id_1"]}` — 指定部门
- `{kind: "all"}` — 全员（需 push:broadcast 权限）

**不接受**手写收件人列表（必须用已注册的 selector）。

## 安全机制

- **首触发安全门**：新 workflow 首次触发自动发送给创建者本人，确认内容无误后放开
- **限速**：500 人次/小时，单次最多 50 收件人（broadcast 豁免上限仍限速）
- **三层鉴权**：服务 JWT（openclaw:push）+ 人员权限（push:configure）+ 引擎闸

## 环境变量

- `PUSH_API_URL`：web 内部 push API 地址（默认 http://web:3000/api/push）
- `CASDOOR_ORIGIN` / `CASDOOR_CLIENT_ID` / `CASDOOR_CLIENT_SECRET`：Casdoor client_credentials
