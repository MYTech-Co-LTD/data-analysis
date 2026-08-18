# deploy/nginx/user_conf.d/server.conf.tpl
# nginx 网关配置模板（jonasal/nginx-certbot 会自动签发并填入 Let's Encrypt 证书）。
# __DOMAIN__ 由 scripts/deploy.sh 从 .env 的 DOMAIN 替换为真实域名，生成同目录 server.conf。
#
# 流量分流：
#   / /mobile /reports /sources /settings /auth/*  → web:3000（前端 Next.js，含 OAuth 回调页）
#   /api /functions /dashboard /mcp               → insforge:7130（InsForge API + edge function）
# 注意：本项目用企微自建 OAuth（不走 InsForge auth provider），InsForge 7131 不对外，
#       避免劫持前端的 /auth/callback 路由。

server {
    listen 443 ssl;
    http2 on;
    server_name __DOMAIN__;

    # 证书由 nginx-certbot 自动签发到 /etc/letsencrypt/live/<domain>/
    ssl_certificate /etc/letsencrypt/live/__DOMAIN__/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/__DOMAIN__/privkey.pem;
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_ciphers HIGH:!aNULL:!MD5;

    # 数据导入等上传体积
    client_max_body_size 50m;

    # 企微可信域名验证文件（域名根路径，由 deploy/nginx/verify/ 挂载）
    location ~ ^/WW_verify_.*\.txt$ {
        root /etc/nginx/verify;
        default_type text/plain;
    }

    # ---------- 前端 Next.js（默认路由，含所有页面与 /auth/callback）----------
    location / {
        proxy_pass http://web:3000;
        # 2026-08-17: PR#13 后 JWT claims 膨胀（branch_nums 388 店 → Set-Cookie 实测 8250B），
        # nginx 默认 proxy buffer（4k/8k）撑不住 /auth/callback 响应头 → 502「upstream sent too big header」。
        # 16k = 当前 2 倍余量；门店数/授权面再显著增长时需同步调大。
        proxy_buffer_size 16k;
        proxy_buffers 8 16k;
        proxy_busy_buffers_size 32k;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    # ---------- 前端管理 API（Next.js Route Handlers）----------
    # 必须放在 /api 之前：nginx 最长前缀匹配优先，/api/admin/* 与 /api/auth/* 命中此块转给 web，
    # 其余 /api 仍走 InsForge。否则被 /api → insforge 遮蔽，管理后台返回 Cannot POST / 404。
    # proxy_pass 不带路径 → 保留完整原始 URI 传给 Next.js。
    location /api/admin {
        proxy_pass http://web:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    location /api/auth {
        proxy_pass http://web:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    # 企微通讯录回调（web/api，架构 §7.1.2）——最长前缀匹配优先于 /api 兜底 → web:3000
    # 否则 /api 兜底送到 insforge:7130，raw XML body 被 gateway 吞成 {}
    location /api/wecom-contacts-webhook {
        proxy_pass http://web:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    # 当前用户权限 claims（web/api，F2.1）——前端 use-can-see-cost / 目标页裁剪提示
    # 依赖 /api/me 判 can_see_cost 等 claims；先前漏放行致生产 404（Cannot GET，兜底到 insforge）
    location /api/me {
        proxy_pass http://web:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    # ---------- 统一推送中心（2026-08-18 生产接线）----------
    # /api/push：openclaw push-admin 插件 / 内部 job 走容器网 http://web:3000 直连；
    # 但 Novu 回调与外部验证需公网可达，且统一走 nginx（限速/日志同源）。
    # /api/wecom-bridge/<token>：Novu worker（novu 服务器）投递回调入口——双层验签在 web 侧，
    # 此处只透传。两者都必须在 /api 兜底（insforge:7130）之前，否则 404 Cannot POST（接线实测）。
    location /api/push {
        proxy_pass http://web:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    location /api/wecom-bridge {
        proxy_pass http://web:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    # ---------- InsForge API ----------
    location /api {
        proxy_pass http://insforge:7130;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    # ---------- InsForge Edge Functions ----------
    location /functions {
        proxy_pass http://insforge:7130;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_read_timeout 300s;
    }

    # ---------- InsForge Dashboard ----------
    location /dashboard {
        proxy_pass http://insforge:7130;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }

    # ---------- MCP Server（edge function 代理，长超时）----------
    location /mcp {
        proxy_pass http://insforge:7130;
        proxy_set_header Host $host;
        proxy_read_timeout 300s;
        proxy_connect_timeout 75s;
    }

    # ---------- openclaw Webhook（企微回调）----------
    # 注意：openclaw gateway 端口为 18789，企微 channel 需要在 openclaw.json 中配置
    location /webhook/wecom {
        proxy_pass http://deploy-openclaw-1:18789;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 120s;
        proxy_connect_timeout 60s;
    }

    # ---------- openclaw Control UI（仅内部访问）----------
    location /openclaw/ {
        proxy_pass http://deploy-openclaw-1:18789/;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
