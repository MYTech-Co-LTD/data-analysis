# Novu 控制面部署 runbook（U3 / plan Task 5 / spec §5.5）

> 状态：**部署完成（待 DNS + Caddy 白名单生效）**。本文档包含全部离线产出：完整 compose、镜像搬运步骤、容量实测、上线步骤清单。
> 执行记录（2026-08-15）：6 容器 healthy；管理员 admin@shanhaiyiguo.com 已建；org=shanhai 已建；注册闸已关；ApiKey 已注入 data 侧；MongoDB TTL 90d 已设；workflow export cron 已加。待办：DNS `novu-api.shanhaiyiguo.com → 113.249.101.33` + Caddy reload + rclone 配置。
> 目标机：控制面 `113.249.101.33`（SSH 别名 `opsh`，密钥 `~/.ssh/openship-ops`）。本机参考栈：Mac 上在跑的 Novu 3.19.0（docker ps：api/worker/ws/dashboard/redis/mongodb）。
> 上游参考：`源码分析/novu/docker/community/docker-compose.yml`（commit fc9a0fd2）+ 本机在跑栈 `docker inspect` 实测（2026-08-15）。
> 同步注记：compose 与本文 README 由**编排者事后同步入 casdoor-infra 仓 `deploy/novu/`**（本 task 未动该仓）。

---

## 0. 容量测算（gate，实测 2026-08-15）

只读命令（data-analysis 侧执行，无控制面写操作）：

```bash
ssh opsh 'df -h /opt; free -m'
```

实测输出：

```
== df -h /opt ==
Filesystem      Size  Used Avail Use% Mounted on
/dev/vda1        40G   15G   26G  37% /

== free -m ==
               total        used      free      shared  buff/cache   available
Mem:            7685     2598      3082        69       2379        5086
Swap:           2047      838      1209
```

Gate 对照（spec §5.5：磁盘 ≥8G 余量、RAM ≥4G）：

| 指标 | gate | 实测 | 结论 |
|---|---|---|---|
| /opt（=/）磁盘余量 | ≥8G | **26G** | ✅ 通过 |
| RAM available | ≥4G | **5086MB**（总 7685MB，Casdoor/openship 同机已用 2598MB） | ✅ 通过 |

磁盘预算估算：镜像合计约 1.5G（api/worker/ws 各 ~0.3G、dashboard ~0.1G、mongo ~0.3G、redis ~0G，本机 `docker image inspect .Size` 实测）+ mongodb 数据（90d TTL 限幅，低量通知场景 <2G）+ 容器日志（json-file 50m×5×6 容器 = 上限 1.5G）≈ 最坏 **~5G**，26G 余量充足。

⚠️ 注记：swap 已用 838MB（同机 Casdoor/openship/uptime-kuma 负载下内存偏紧），Novu 栈常驻预计再加 2-4G（spec §5.5 口径）。上线后观察 `free -m` 与 swap 走势，若 available 持续 <2G 需评估扩容或迁移。

## 1. 镜像清单与固定 tag（tag 固定 = spec §5.5 铁律）

本机在跑栈实测（`docker inspect --format '{{.Config.Image}}'` + `docker image inspect RepoDigests`）：

| 服务 | 镜像（本机在跑） | 固定为 | digest（sha256，搬运后校验用） |
|---|---|---|---|
| api | ghcr.io/novuhq/novu/api:latest | **3.19.0**（health-check apiVersion 实测=3.19.0） | 5cd2a586888b48885cb9ad91fb3cd25a38e6f70bb99d38d48f4d475b57bf544a |
| worker | ghcr.io/novuhq/novu/worker:latest | **3.19.0** | 2fa72651958986570f3929df0079908a6a4c65f945cf8fa69d973c707ce4ac81 |
| ws | ghcr.io/novuhq/novu/ws:latest | **3.19.0** | 61560aaf8b60a9ea38cec7cd5976a441ef7f90721892a0d38958b3ac17196836 |
| dashboard | ghcr.io/novuhq/novu/dashboard:latest | **3.19.0** | 15a7773e01658f671e56fb9f0ddc8f043008bb0cfea2d6c5d1a0a60c722bf6e1 |
| redis | redis:alpine | **alpine**（digest 锁定） | 978f0e01593e65eed801f2402944efcd936d43b5027e4908a7897baf88ed6241 |
| mongodb | mongo:8.0.17 | **8.0.17** | 9814652e33f0cf8b9fddea8b46dfc9d8e19b130dcfdd7b510ca58bb0d40c8b71 |

## 2. 镜像搬运（跨境拉取 ghcr.io 不通，经天翼云镜像仓中转）

私有镜像仓：`caj9ik14016wep.xuanyuan.run`（控制面 casdoor 已在用；本机 `~/.docker/config.json` 已有该 registry 凭证，凭证存 Docker Desktop keychain）。

**在本地 Mac（已有全部镜像）执行**——先 tag 再 push：

```bash
REG=caj9ik14016wep.xuanyuan.run
for svc in api worker ws dashboard; do
  docker tag ghcr.io/novuhq/novu/$svc:3.19.0 $REG/ghcr.io/novuhq/novu/$svc:3.19.0
  docker push $REG/ghcr.io/novuhq/novu/$svc:3.19.0
done
docker tag redis:alpine $REG/library/redis:alpine && docker push $REG/library/redis:alpine
docker tag mongo:8.0.17 $REG/library/mongo:8.0.17 && docker push $REG/library/mongo:8.0.17
```

> 注：novuhq 镜像在 ghcr.io（非 docker hub）。命名空间用 `ghcr.io/novuhq/novu/...` 前缀以示来源；若该 registry 对非 `library/`/hub 命名空间推送有权限限制，退化方案为 (a) 让仓管理员开权限，或 (b) 在可直连 ghcr 的境外 CI 中转。push 后在控制面 `docker pull` 校验 digest 与上表一致（`docker image inspect --format '{{json .RepoDigests}}'`）。

**升级流程**（半年评估一次，spec §5.5）：本地先 `docker pull` 新 tag 起参考栈验证 → 重跑搬运步骤 → 控制面改 compose tag → `docker compose up -d`。订阅 novuhq/novu releases advisory。

## 3. 完整 docker-compose.yml（放 `/opt/novu/docker-compose.yml`）

6 服务；端口**仅绑 127.0.0.1**（公网入口一律走宿主机 Caddy 反代，dashboard 仅 SSH 隧道内网访问）；`DISABLE_USER_REGISTRATION=true`（建完管理员账号后再加上线，见 §4 步骤 6）；redis 未设密码（仅 compose 内网可达，硬化待选项见 §7）。

```yaml
name: novu

x-logging: &default-logging
  driver: "json-file"
  options:
    max-size: "50m"
    max-file: "5"

services:
  redis:
    image: caj9ik14016wep.xuanyuan.run/library/redis:alpine   # redis@sha256:978f0e01...
    container_name: novu-redis
    restart: unless-stopped
    logging: *default-logging
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 10s
      timeout: 5s
      retries: 5

  mongodb:
    image: caj9ik14016wep.xuanyuan.run/library/mongo:8.0.17   # mongo@sha256:9814652e...
    container_name: novu-mongodb
    restart: unless-stopped
    logging: *default-logging
    environment:
      - MONGO_INITDB_ROOT_USERNAME=${MONGO_INITDB_ROOT_USERNAME}
      - MONGO_INITDB_ROOT_PASSWORD=${MONGO_INITDB_ROOT_PASSWORD}
    volumes:
      - novu_mongodb:/data/db
    healthcheck:
      test:
        [
          "CMD", "mongosh", "--quiet",
          "--username", "${MONGO_INITDB_ROOT_USERNAME}",
          "--password", "${MONGO_INITDB_ROOT_PASSWORD}",
          "--eval", "db.adminCommand('ping').ok",
        ]
      interval: 20s
      timeout: 5s
      retries: 5
      start_period: 20s

  api:
    image: caj9ik14016wep.xuanyuan.run/ghcr.io/novuhq/novu/api:3.19.0   # @sha256:5cd2a586...
    container_name: novu-api
    depends_on:
      mongodb:
        condition: service_healthy
      redis:
        condition: service_healthy
    restart: unless-stopped
    logging: *default-logging
    environment:
      NODE_ENV: production
      PORT: ${API_PORT}
      API_ROOT_URL: ${API_ROOT_URL}
      FRONT_BASE_URL: ${FRONT_BASE_URL}
      DISABLE_USER_REGISTRATION: ${DISABLE_USER_REGISTRATION}
      MONGO_URL: ${MONGO_URL}
      MONGO_MIN_POOL_SIZE: 5
      MONGO_MAX_POOL_SIZE: 10
      MONGO_AUTO_CREATE_INDEXES: "true"
      REDIS_HOST: redis
      REDIS_PORT: 6379
      REDIS_PASSWORD: ${REDIS_PASSWORD}
      REDIS_DB_INDEX: 2
      REDIS_CACHE_SERVICE_HOST: ""
      REDIS_CACHE_SERVICE_PORT: 6379
      JWT_SECRET: ${JWT_SECRET}
      STORE_ENCRYPTION_KEY: ${STORE_ENCRYPTION_KEY}
      NOVU_SECRET_KEY: ${NOVU_SECRET_KEY}
      SUBSCRIBER_WIDGET_JWT_EXPIRATION_TIME: 15d
      SENTRY_DSN: ""
      NEW_RELIC_ENABLED: "false"
      IS_API_IDEMPOTENCY_ENABLED: "false"
      IS_API_RATE_LIMITING_ENABLED: "false"
      IS_NEW_MESSAGES_API_RESPONSE_ENABLED: "true"
      IS_V2_ENABLED: "true"
      IS_SELF_HOSTED: "true"
    ports:
      - "127.0.0.1:${API_PORT}:${API_PORT}"
    healthcheck:
      test:
        [
          "CMD-SHELL",
          "wget --no-verbose --tries=1 --spider http://localhost:$${PORT}/v1/health-check || exit 1",
        ]
      interval: 20s
      timeout: 10s
      retries: 3
      start_period: 40s

  worker:
    image: caj9ik14016wep.xuanyuan.run/ghcr.io/novuhq/novu/worker:3.19.0   # @sha256:2fa72651...
    container_name: novu-worker
    depends_on:
      mongodb:
        condition: service_healthy
      redis:
        condition: service_healthy
    restart: unless-stopped
    logging: *default-logging
    environment:
      NODE_ENV: production
      PORT: 3004
      API_ROOT_URL: http://api:${API_PORT}
      MONGO_URL: ${MONGO_URL}
      MONGO_MIN_POOL_SIZE: 5
      MONGO_MAX_POOL_SIZE: 10
      REDIS_HOST: redis
      REDIS_PORT: 6379
      REDIS_PASSWORD: ${REDIS_PASSWORD}
      REDIS_DB_INDEX: 2
      REDIS_CACHE_SERVICE_HOST: ""
      REDIS_CACHE_SERVICE_PORT: 6379
      STORE_ENCRYPTION_KEY: ${STORE_ENCRYPTION_KEY}
      SUBSCRIBER_WIDGET_JWT_EXPIRATION_TIME: 15d
      SENTRY_DSN: ""
      NEW_RELIC_ENABLED: "false"
      BROADCAST_QUEUE_CHUNK_SIZE: 100
      MULTICAST_QUEUE_CHUNK_SIZE: 100
    healthcheck:
      test:
        [
          "CMD-SHELL",
          "wget --no-verbose --tries=1 --spider http://localhost:$${PORT:-3004}/v1/health-check || exit 1",
        ]
      interval: 20s
      timeout: 10s
      retries: 3
      start_period: 20s

  ws:
    image: caj9ik14016wep.xuanyuan.run/ghcr.io/novuhq/novu/ws:3.19.0   # @sha256:61560aaf...
    container_name: novu-ws
    depends_on:
      mongodb:
        condition: service_healthy
      redis:
        condition: service_healthy
    restart: unless-stopped
    logging: *default-logging
    environment:
      PORT: ${WS_PORT}
      NODE_ENV: production
      MONGO_URL: ${MONGO_URL}
      MONGO_MIN_POOL_SIZE: 5
      MONGO_MAX_POOL_SIZE: 10
      REDIS_HOST: redis
      REDIS_PORT: 6379
      REDIS_PASSWORD: ${REDIS_PASSWORD}
      JWT_SECRET: ${JWT_SECRET}
      SENTRY_DSN: ""
      NEW_RELIC_ENABLED: "false"
    ports:
      - "127.0.0.1:${WS_PORT}:${WS_PORT}"
    healthcheck:
      test:
        [
          "CMD-SHELL",
          "wget --no-verbose --tries=1 --spider http://localhost:$${PORT}/v1/health-check || exit 1",
        ]
      interval: 20s
      timeout: 10s
      retries: 3
      start_period: 40s

  dashboard:
    image: caj9ik14016wep.xuanyuan.run/ghcr.io/novuhq/novu/dashboard:3.19.0   # @sha256:15a7773e...
    container_name: novu-dashboard
    depends_on:
      api:
        condition: service_healthy
      worker:
        condition: service_healthy
    restart: unless-stopped
    logging: *default-logging
    environment:
      VITE_API_HOSTNAME: ${VITE_API_HOSTNAME}
      VITE_WEBSOCKET_HOSTNAME: ${VITE_WEBSOCKET_HOSTNAME}
    ports:
      - "127.0.0.1:4000:4000"
    healthcheck:
      test:
        [
          "CMD-SHELL",
          'node -e "const http = require(''http''); const req = http.get({hostname: ''localhost'', port: 4000, path: ''/'', timeout: 5000}, (res) => { process.exit(res.statusCode === 200 ? 0 : 1); }); req.on(''error'', () => process.exit(1)); req.on(''timeout'', () => { req.destroy(); process.exit(1); });"',
        ]
      interval: 20s
      timeout: 10s
      retries: 3
      start_period: 20s

volumes:
  novu_mongodb: ~
```

> 上线前用 `docker compose config -q` 验语法（compose 与 .env 放好后先跑一遍）。

### /opt/novu/.env（模板，chmod 600，不入库）

```bash
# 端口（宿主机侧仅 127.0.0.1）
API_PORT=3000
WS_PORT=3002

# 公网入口（Caddy 反代后的地址；dashboard 走内网隧道时 FRONT_BASE_URL 用 http://127.0.0.1:4000）
API_ROOT_URL=https://novu-api.shanhaiyiguo.com
FRONT_BASE_URL=http://127.0.0.1:4000
VITE_API_HOSTNAME=https://novu-api.shanhaiyiguo.com
VITE_WEBSOCKET_HOSTNAME=wss://novu-ws.shanhaiyiguo.com   # 若 ws 不公网暴露，用隧道侧 http://127.0.0.1:3002

# mongodb（强密码：openssl rand -hex 16）
MONGO_INITDB_ROOT_USERNAME=novu
MONGO_INITDB_ROOT_PASSWORD=<openssl-rand-hex-16>
MONGO_URL=mongodb://novu:<同上密码>@mongodb:27017/novu-db?authSource=admin

# redis（内网无密码；如启用 requirepass 同步改这里）
REDIS_PASSWORD=

# 三密钥（照官方 setup.sh 生成口径：openssl rand -hex 32 / 16 / 32）
JWT_SECRET=<openssl-rand-hex-32>
STORE_ENCRYPTION_KEY=<openssl-rand-hex-16>
NOVU_SECRET_KEY=<openssl-rand-hex-32>

# 注册闸：建完管理员账号后改 true 再 docker compose up -d（重建 api 生效）
DISABLE_USER_REGISTRATION=false
```

## 4. 人执行步骤清单（控制面，按序）

1. **镜像搬运**：按 §2 在本地 Mac push，控制面 `docker pull` 逐个核对 digest（§1 表）。
2. **建目录放文件**：`ssh opsh 'mkdir -p /opt/novu'`；放入 `docker-compose.yml`（§3）与 `.env`（§3 模板，生成密钥、chmod 600），`docker compose config -q` 验语法。
3. **起栈**：`ssh opsh 'cd /opt/novu && docker compose up -d'`；`docker ps` 看 6 容器 healthy；`curl -s http://127.0.0.1:3000/v1/health-check` 期望 `{"data":{"status":"ok",...,"apiVersion":{"version":"3.19.0"...}}}`。
   > 健康端点为 `/v1/health-check`（本机实测）；根路径 `/health` 返 404 不存在。
4. **建管理员账号**：SSH 隧道开 dashboard：本地 `ssh -L 4000:127.0.0.1:4000 -L 3002:127.0.0.1:3002 opsh`，浏览器开 `http://localhost:4000`，注册 **2-3 个平台管理员**（邮箱+强密码；此时尚未关注册）。同时把 ws 隧道端口带上，dashboard 实时连接才可用。
5. **建组织**：org 名 **shanhai**（后续 trigger/workflow 都挂此 org 下）。
6. **关注册闸**：`.env` 改 `DISABLE_USER_REGISTRATION=true` → `docker compose up -d`（重建 api）。验证：dashboard 退出后再注册应报 `Account creation is disabled`（源码 `user-register.usecase.ts:21`：env==='true' 即拒）。
7. **trigger ApiKey 生成与注入 web env**：dashboard → Settings → API Keys，复制 key；在 **data 侧** `deploy/.env` 追加：
   ```
   NOVU_API_URL=https://novu-api.shanhaiyiguo.com
   NOVU_API_KEY=<ApiKey>
   ```
   （`deploy/.env.example` 已有占位与注释。）
8. **Caddy 反代 + 双向白名单**（V1b 待验证注记见 §5）。
9. **mongodb TTL 索引**（§6）。
10. **探活接线**（§7）+ data 侧 curl trigger API 验证。
11. **workflow export cron**（§8）。
12. 完成后：编排者把本文 compose + README 同步进 casdoor-infra 仓 `deploy/novu/`。

## 5. 网络与双向白名单（含 V1b 待验证注记）

- **data → Novu（trigger/探活）**：data 服务器（data.shanhaiyiguo.com，出口 IP **113.249.120.84**）→ `https://novu-api.shanhaiyiguo.com`（Caddy → 127.0.0.1:3000）。Caddy 层按源 IP 限死只放行 113.249.120.84（`@allowed remote_ip 113.249.120.84` + `handle` 403 兜底）。
- **Novu → data（chat-webhook 回调）**：Novu worker 出站调 data 侧 `/api/wecom-bridge/<token>`（公网域名 data.shanhaiyiguo.com）；data 侧前置 nginx 按 Novu 控制面出口 IP（同 113.249.101.33）加白（Task 6 bridge 落地时配置）。
- **dashboard 仅内网**：4000 只绑 127.0.0.1，管理员经 SSH 隧道访问（§4 步骤 4），不经公网。
- **⚠️ V1b 待验证注记**（spec §4 身份视图表尾）：「Novu API 白名单仅接受 data IP」的实现载体待 P0-V1b 验证——Novu **企业版是否原生支持 IP allowlist 未验证**；社区版（本部署）无此功能，**落 Caddy `remote_ip` 白名单兜底**。V1b 结论出来前以 Caddy 为准；若后续验证 CE 有原生方案再迁移。
- Caddyfile 在控制面 `/etc/caddy/Caddyfile`（不在本仓，归控制面运维），追加示例：

```
novu-api.shanhaiyiguo.com {
    @allowed remote_ip 113.249.120.84
    handle @allowed {
        reverse_proxy 127.0.0.1:3000
    }
    handle {
        respond 403
    }
}
```

## 6. mongodb TTL 索引（notifications/events 90d）

**关键澄清（防误删工作流定义）**：Novu 的 `notifications` 集合存的是 **workflow 模板定义**（Collection 名与直觉相反），**绝不能对其建 TTL**；运行时事件数据在 `messages`（发送记录）与 `executiondetails`（执行明细）。spec §5.5「notifications/events 90d」按此落为 **`messages` + `executiondetails` 两集合 90d TTL**。

两者已有 `createdAt_1` 索引（本机栈实测，无 expireAfterSeconds），用 `collMod` 直接加 TTL（90d = 7776000s）：

```bash
ssh opsh 'docker exec novu-mongodb mongosh --quiet -u novu -p <密码> --authenticationDatabase admin novu-db --eval "
db.runCommand({collMod: \"messages\", index: {keyPattern: {createdAt: 1}, expireAfterSeconds: 7776000}});
db.runCommand({collMod: \"executiondetails\", index: {keyPattern: {createdAt: 1}, expireAfterSeconds: 7776000}});
"'
```

验证：`db.messages.getIndexes().filter(i => i.expireAfterSeconds)` 应各返回 1 条。

> 磁盘水位 80% 告警（spec §5.5）：控制面已有 uptime-kuma，加一个 /opt 使用率监控项即可（人执行，非本 task 范围）。mongodump 全量备份为磁盘充裕时的可选项（F6 定案：仅 workflow export 必做）。

## 7. 探活（data 侧，已随本 task 落码）

- evaluator：`web/lib/monitor/evaluators/novu-probe.ts`（`check_type='novu_health'`）；`NOVU_API_URL` 空 = 探活禁用不告警；探 `GET ${NOVU_API_URL}/v1/health-check`，失败 → firing → 现有 service_down 告警链路（企微）。
- 单测：`web/lib/monitor/__tests__/novu-probe.test.ts`（disabled/healthy/不可达/非2xx/URL拼接 五态）。
- **规则种子已迁移化**：`database/migrations/174_monitor_seed_novu.sql`（幂等 INSERT ... ON CONFLICT DO NOTHING，本地 dev 库实测跑两遍=1 行）；随 GHA 部署自动落库。接线：`web/lib/monitor/runtime.ts` 的 `SERVICE_DOWN_BUCKET_TYPES` 含 `novu_health`（随 service_down 桶每分钟节奏）。
- **人执行（上线后）**：data 侧 `deploy/.env` 填 `NOVU_API_URL`（§4 步骤 7）即启用探活（env 空 = evaluator disabled，规则行在库也无害）。
- 红绿实测（人执行）：先用错误 NOVU_API_URL 验证红（企微收 `{svc} 不可达` 告警）、改正确值验证绿（告警 resolve ✅）。

## 8. workflow export cron（每日，落 data 侧对象存储）

F6 定案：仅 workflow 定义 export 必做。workflow 定义集中在 mongodb `notifications`（+ `notificationtemplates`）集合，**从控制面导出、落 data 侧对象存储**（casdoor-infra adapters 层同款桶+rclone 模式）。

控制面 crontab（示例，每日 02:30）：

```bash
# /opt/novu/export-workflows.sh（chmod 700）
#!/usr/bin/env bash
set -euo pipefail
STAMP=$(date +%F)
OUT=/tmp/novu-workflows-$STAMP.json.gz
docker exec novu-mongodb mongosh --quiet -u novu -p "$MONGO_PW" --authenticationDatabase admin novu-db \
  --eval 'JSON.stringify({notifications: db.notifications.find().toArray(), notificationtemplates: db.notificationtemplates.find().toArray(), exportedAt: new Date()})' \
  | gzip > "$OUT"
rclone copy "$OUT" <data侧对象存储remote>:novu-backup/workflows/   # remote 按 casdoor-infra adapters 层配置
rm -f "$OUT"
```

crontab -e：`30 2 * * * /opt/novu/export-workflows.sh >> /var/log/novu-export.log 2>&1`
（rclone 配置与桶名由人按 casdoor-infra 侧对象存储实际落地填；本 task 不建桶。）

## 9. 回滚 / 降级

- 栈级回滚：`cd /opt/novu && docker compose down`（数据卷保留）；镜像回旧 tag 再 up。
- 业务降级（spec §5.5）：Novu 连续失败（探活红/trigger 持续非 2xx）→ 自动回退 wecom-notify 直投（引擎同产物），由推送引擎侧实现（Task 8+），本文档只记录口径。

## 10. 已知留白（非本 task 范围）

- redis requirepass 硬化（当前仅 compose 内网）。
- 磁盘水位 80% 告警接入 uptime-kuma。
- V1b（CE 原生 IP allowlist）验证。
- casdoor-infra `deploy/novu/` 同步（编排者事后）。
