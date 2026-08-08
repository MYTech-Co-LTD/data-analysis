# deploy/nginx/sso.conf.tpl
# Casdoor SSO 反代配置模板（jonasal/nginx-certbot 会自动签发并填入 Let's Encrypt 证书）。
# __SSO_DOMAIN__ 由 scripts/deploy.sh 从 .env 的 SSO_DOMAIN 替换为真实域名，生成同目录 sso.conf。
#
# 流量：全部 → casdoor:8000（Casdoor 身份提供者，OIDC 端点 + 内置管理 UI）
# HTTP→HTTPS 重定向由 nginx-certbot 镜像内置的 port 80 default_server 自动处理
#   （与 data.shanhaiyiguo.com 同机制，无需额外 server block）。
# 证书签发/续期同样由 nginx-certbot 镜像自动完成——首次启动时检测到
#   /etc/letsencrypt/live/<domain>/ 不存在，自动用自签证书引导 nginx 启动，
#   再以 HTTP-01 challenge 申请 Let's Encrypt 正式证书并 reload。

server {
    listen 443 ssl;
    http2 on;
    server_name __SSO_DOMAIN__;

    # 证书由 nginx-certbot 自动签发到 /etc/letsencrypt/live/<domain>/
    ssl_certificate /etc/letsencrypt/live/__SSO_DOMAIN__/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/__SSO_DOMAIN__/privkey.pem;
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_ciphers HIGH:!aNULL:!MD5;

    # Casdoor 头像/附件上传
    client_max_body_size 20m;

    location / {
        proxy_pass http://casdoor:8000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
