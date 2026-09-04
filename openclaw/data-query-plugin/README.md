# data-query plugin

OpenClaw native tool-plugin：把可信企微 userid 透传到 agent-query 网关，实现**全局工具 + 后端按人鉴权**的零售数据查询（架构文档 `docs/architecture.md` §4.3）。

## 为什么是 native plugin 而非远程 MCP

OpenClaw 核心每轮把企微 `fromUser` 注入 native plugin tool 的 `toolContext.requesterSenderId`，但**不会**透传给 `mcp.servers`。要拿可信 userid 做按人鉴权，只能用 native plugin 的 **factory 形式** `api.registerTool((toolContext) => toolDef)`。

## 组件

| 文件 | 作用 |
|---|---|
| `dist/index.js` | 入口：`definePluginEntry` + factory `registerTool`，读 `toolContext.requesterSenderId` + `process.env.AGENT_API_KEY`，POST 到 agent-query 网关 |
| `openclaw.plugin.json` | manifest：`contracts.tools:["query_retail_data"]` + `activation.onStartup:true`（全局）+ `skills:["./skills"]` |
| `skills/retail-query/SKILL.md` | 教模型何时/如何查询（retail_detail 列、汇总表、DuckDB/PG 写法、规则） |
| `package.json` | `openclaw.extensions:["./dist/index.js"]`；无 npm 运行时依赖（不用 typebox，parameters 用纯 JSON schema） |

## 数据流

```
企微用户提问
  → OpenClaw core 注入 toolContext.requesterSenderId = <wecom userid>
  → query_retail_data.execute({sql})
  → POST http://insforge:7130/functions/agent-query  body={sql, userId, agent_api_key}
  → 网关：认证 → get_user_perms(userId) → SQL 白名单 → 引擎路由(DuckDB/PG) → 审计
  → 返回 {engine, perms, rowCount, data}（行按 branch_nums、成本列按 can_see_cost 脱敏）
```

`AGENT_API_KEY` 留在 openclaw 容器 env（compose 注入），不进 LLM/用户上下文。

## 部署（openclaw 是手动 SSH 部署面，GHA 不推 openclaw/）

```bash
# 1. 同步插件源码到服务器持久路径（openclaw/state 是挂载卷）
scp -r openclaw/data-query-plugin \
  root@data.shanhaiyiguo.com:/opt/data-analytics-platform/openclaw/state/plugins/

# 2. 容器内 link 安装（自动写 openclaw.json 的 plugins.{entries,allow}）
ssh root@data.shanhaiyiguo.com "docker exec deploy-openclaw-1 \
  node openclaw.mjs plugins install -l /home/node/.openclaw/plugins/data-query-plugin"

# 3. 重启 gateway 加载
ssh root@data.shanhaiyiguo.com "docker restart deploy-openclaw-1"

# 4. 验证
docker exec deploy-openclaw-1 node openclaw.mjs plugins list
docker exec deploy-openclaw-1 node openclaw.mjs plugins inspect data-query --runtime
docker exec deploy-openclaw-1 node openclaw.mjs skills list
```

## 前置条件

- openclaw 容器 env 有 `AGENT_API_KEY`（与 agent-query function secret 同值）+ `AGENT_QUERY_URL`（默认 `http://insforge:7130/functions/agent-query`）—— 见 `deploy/docker-compose.prod.yml`。
- agent-query 网关、`get_user_perms`、`execute_sql_rls`、DuckDB 权限视图均已部署（§4.2）。

## 变更记录

- 2026-09-04(2) **定时任务投递渠道默认改为对话**：`create_scheduled_report` 新增 `delivery` 参数（默认 `chat`=机器人对话，私聊 delivery={mode:announce,channel:wecom,to:创建者}，文本由 cron delivery 投递、文件由 turn 内直发；群聊不变=本群）；仅用户特别强调「消息通知推送」时传 `notify`（=原 push_report 应用消息模式）。
  同时修复：delivery 旧格式 `{announce:'announce'}` 已被 openclaw 新版 schema 拒绝（实测 cron.add INVALID_REQUEST），改为 `{mode:'announce'}`；skill 同步更新投递渠道规则。实测：SDK 建测试 job（mode:announce→私聊 to=ZhangDuo）创建成功且 WS 投递 ack。
- 2026-09-04(1) `create_scheduled_report` payload 模板补投递指令：`...查数据，再用 push_report 推送结果`。
  根因（job d124af21 两日无推送）：私聊任务 `delivery={mode:none}`，投递全靠 turn 内 push_report，
  但旧模板只写「查数据并汇报结果」，turn 查完数只写 summary 就结束，无人收到。
  存量 job 已同步修 payload 并实测触发验证通过（wecom-notify 200，summary「日报推送完成」）。

## 卸载注意

`plugins uninstall --force` 会残留 `plugins.load.paths` 指向已删目录，致 gateway 崩溃。卸载后用 `openclaw doctor --fix` 或手动清 `openclaw.json` 的 `load.paths`。
