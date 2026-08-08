# Casdoor 独立化迁移设计（寄生 data-analysis → 控制面平台级身份服务）

> 状态：设计批准 · 2026-08-09
> 范围：Casdoor 从 data-analysis（113.249.120.84）迁到控制面（113.249.101.33），成为和 openship 平级的独立身份基础设施。data-analysis 退化为普通 OIDC client。
> 关联：[[2026-08-08-casdoor-wecom-sso-design]]（Casdoor SSO 基石，本轮在其上独立化）

---

## 1. 背景与目标

### 1.1 现状（寄生）
Casdoor 当前寄生在 data-analysis：
- 部署在 data-analysis 机（113.249.120.84），容器 `deploy-casdoor-1`
- 配置在 data-analysis 仓 `deploy/casdoor/`（app.conf、init-role.sql）
- 复用 data-analysis 的 postgres（`deploy-postgres-1`，casdoor 角色 + casdoor db）
- nginx-certbot 反代 `sso.shanhaiyiguo.com` → casdoor:8000
- 只服务 `shanhai` 一个 org（企微同步）
- data-analysis 的 `wecom-oidc-callback` function 接它做 OIDC 登录

问题：身份中心寄生业务系统——data-analysis 出问题影响全网登录；多企业场景身份中心应中立独立；配置散在 data-analysis 仓，职责不清。

### 1.2 目标（独立化）
迁到控制面，成和 openship 平级的独立身份基础设施：
- **独立栈**：控制面 `/opt/casdoor/`，独立 docker compose（casdoor + 独立 postgres），不受 openship 管
- **独立 postgres**：casdoor-postgres 容器（不与 openship-postgres 共用，故障域 + 升级独立）
- **Caddy 反代**：宿主机 Caddy 加 `sso.shanhaiyiguo.com` 块（自动 HTTPS）
- **多 org 就绪**：Casdoor 原生多 organization，当前 shanhai，未来多企业各一 org + 企微 provider
- **data-analysis 解耦**：仓移除 Casdoor 配置，应用层零改（仍 OIDC 接 sso 域名）

### 1.3 非目标
- 不改 Casdoor 配置逻辑（迁移，非重构；wecom provider / data-analysis app 原样迁）
- 不动 data-analysis 应用层（`wecom-oidc-callback` 的 CASDOOR_ISSUER 不变）
- 不在本轮做具体多企业 org（架构就绪，企业后续按需加）

---

## 2. 目标架构

```
控制面 113.249.101.33（7.5G 内存，可用 5.7G）
├── openship 栈（/opt/openship，部署平台）—— 不动
├── Caddy（宿主机 /usr/local/bin/caddy，80/443，自动 HTTPS）
│   ├── deploy.hookflow.cn → openship-web
│   └── sso.shanhaiyiguo.com → casdoor:8000  ← 新增反代块
├── Casdoor 栈（/opt/casdoor，独立，与 openship 平级）  ← 新增
│   ├── casdoor 容器（casbin/casdoor）
│   └── casdoor-postgres 容器（postgres:16-alpine，独立实例）
├── smart-proxy（4878）/ uptime-kuma —— 不动
└── DNS：sso.shanhaiyiguo.com → 113.249.101.33（从 113.249.120.84 切）

data-analysis 113.249.120.84
├── 移除：casdoor 服务 / nginx sso.conf / deploy/casdoor 配置
├── 保留：casdoor db（回滚兜底，迁移验证后再清）
└── wecom-oidc-callback 仍 OIDC 接 sso.shanhaiyiguo.com（IP 透明切，应用层零改）
```

---

## 3. 迁移 Runbook

### 阶段 1：控制面建 Casdoor 栈（不起旧 DNS，先就绪）
1. 控制面建 `/opt/casdoor/`：
   - `docker-compose.yml`：`casdoor`（image `casbin/casdoor:latest`，ports `127.0.0.1:8000:8000`，挂 conf）+ `casdoor-postgres`（`postgres:16-alpine`，volume `casdoor_pg:/var/lib/postgresql/data`，POSTGRES_USER/PASSWORD/DB=casdoor）
   - `conf/app.conf`：`driverName=postgres`，`dataSourceName="user=casdoor password=casdoor_pw host=casdoor-postgres port=5432 sslmode=disable dbname=casdoor"`，`origin=https://sso.shanhaiyiguo.com`
2. `docker compose up -d`，验证 casdoor-postgres + casdoor 健康（casdoor 启动会 AUTO 建表，空库）
3. **镜像拉取**：控制面 docker daemon 若拉 `casbin/casdoor` 超时，配 xuanyuan mirror（daemon.json `registry-mirrors`）或用 `caj9ik14016wep.xuanyuan.run/casbin/casdoor:latest` 前缀（data-analysis 部署验证过的路径）。实施时验证。

### 阶段 2：数据迁移（pg_dump → restore）
1. data-analysis 源：`docker exec deploy-postgres-1 pg_dump -U casdoor -d casdoor > casdoor.sql`（含 shanhai org、wecom_silent/wecom_scan provider、data-analysis app、admin、cert、token 等全部配置）
2. 传控制面：`scp casdoor.sql control:/opt/casdoor/`
3. 目标恢复：`docker exec -i casdoor-postgres psql -U casdoor -d casdoor < casdoor.sql`（先确保 casdoor db 存在 + casdoor 角色）
4. 验证：`SELECT count(*) FROM organization;`（含 shanhai）、`SELECT name FROM application;`（含 data-analysis）、provider 表含 wecom_silent/wecom_scan

### 阶段 3：Caddy 反代
1. `/etc/caddy/Caddyfile` 加块：
   ```
   sso.shanhaiyiguo.com {
       reverse_proxy 127.0.0.1:8000
   }
   ```
2. `caddy reload`（或 systemctl reload caddy），Caddy 自动签 sso 证书
3. 验证：控制面本机 `curl -H "Host: sso.shanhaiyiguo.com" http://localhost/` 通；证书签发成功（Caddy 日志）

### 阶段 4：DNS 切换（用户操作）
1. **提前降 TTL**：DNS sso.shanhaiyiguo.com TTL → 60s（提前 1 天降，等旧 TTL 过期）
2. 改 A 记录：`113.249.120.84` → `113.249.101.33`
3. 等 DNS 全球生效（60s TTL，几分钟内）

### 阶段 5：验证 + data-analysis 下线
1. 验证控制面 Casdoor：
   - `https://sso.shanhaiyiguo.com` 打开（非空白页）
   - 企微内静默登录 data-analysis（走控制面 Casdoor）成功
   - PC 扫码登录成功
   - data-analysis 报表数据正常（RLS 不变）
2. data-analysis 下线旧 Casdoor（验证通过后）：
   - 仓：移除 `deploy/casdoor/`、base `docker-compose.yml` 的 casdoor 服务、`docker-compose.prod.yml` nginx 的 `casdoor` depends_on、`deploy/nginx/` 的 sso.conf.tpl、`.env`/`.env.example` 的 SSO_DOMAIN（SSO_DOMAIN 不再由 data-analysis 管）
   - 服务器：`docker compose stop casdoor`（容器停，数据卷 casdoor db 保留作回滚兜底，迁移稳定 1 周后再清）

### 阶段 6：收尾
- data-analysis 仓改动走 GHA 部署（改配置/compose，非 function）
- 控制 Casdoor 纳入 uptime-kuma 监控（sso.shanhaiyiguo.com，60s）
- 企微告警验证

---

## 4. data-analysis 解耦细节

| 项 | 处理 |
|----|------|
| `deploy/casdoor/`（app.conf、init-role.sql） | 仓移除（迁到控制面 /opt/casdoor） |
| base `docker-compose.yml` casdoor 服务 | 移除 |
| `docker-compose.prod.yml` nginx depends_on casdoor | 移除 casdoor 条件 |
| `deploy/nginx/` sso.conf.tpl | 移除（sso 域名归控制面 Caddy） |
| `.env` / `.env.example` SSO_DOMAIN | 移除（域名不再由 data-analysis nginx 管） |
| `deploy-postgres-1` 的 casdoor db + 角色 | 保留（回滚兜底，稳定后清） |
| `functions/wecom-oidc-callback` | **零改**（CASDOOR_ISSUER=sso.shanhaiyiguo.com 不变，IP 透明切） |
| `web/lib/wecom.ts` buildCasdoorAuthUrl | **零改**（issuer 不变） |

> 注意：data-analysis 的 nginx 不再反代 sso（sso 归控制面 Caddy）。data-analysis nginx 只剩 data 域名。

---

## 5. 多 org 架构（就绪，本轮不实施）

Casdoor 原生多 organization。每家企业：
- 一 org（如 shanhai、future-corp-x）
- 一组企微 provider（wecom_silent + wecom_scan，各自 corp_id/agent/secret）—— 不同企业不同企微
- OIDC application（data-analysis/WeKnora 等作 client，属 org 或跨 org）

本轮迁完即多 org 就绪。加企业 = 建 org + provider + app，零架构改动。

---

## 6. 风险与回滚

| 风险 | 应对 |
|------|------|
| DNS 切换中断 | 提前降 TTL 60s；切后 data-analysis Casdoor 暂留（不停），双端短并存兜底，验证通过再停 |
| 数据迁移不一致（dump 期间写入） | 低峰迁移；或 dump 前 `docker compose stop casdoor`（停写）→ dump → 控制面起。data-analysis 登录短暂中断可接受（低峰） |
| Caddy 证书签发失败 | Caddy 自动重试；失败查 80/443 防火墙 + DNS 已切控制面 |
| 控制面资源不足 | 已验证：可用 5.7G，Casdoor+pg 约 1G，充裕 |
| 回滚 | DNS 切回 113.249.120.84（data-analysis Casdoor 保留未删），分钟级回滚 |

**关键顺序**：控制面就绪 + 数据迁好 + Caddy 验证 → **才** DNS 切 → 验证 → data-analysis 下线。DNS 切前 data-analysis Casdoor 不动（双活兜底）。

---

## 7. WeKnora（迁移后继续）

WeKnora 部署搁置，等本次迁移完成。迁移后：
- WeKnora 接同一个 `sso.shanhaiyiguo.com`（IP 已切控制面）
- AppTemplate 的 OIDC configField（issuer/discovery/client_id/secret）值不变
- 继续：上传 AppTemplate → Casdoor 建 WeKnora OIDC app → post_apps 安装 → 部署

---

## 8. 实施顺序总结

1. 控制面建 Casdoor 栈（casdoor + casdoor-postgres）
2. pg_dump data-analysis casdoor db → 控制面 restore
3. Caddyfile 加 sso 反代 + reload + 验证证书
4. 用户降 DNS TTL + 切 A 记录到控制面
5. 验证登录（企微静默 + PC 扫码 + data-analysis 报表）
6. data-analysis 仓移除 Casdoor 配置（GHA 部署）+ 服务器停 casdoor 容器
7. uptime-kuma 监控 sso
8. 继续 WeKnora 部署
