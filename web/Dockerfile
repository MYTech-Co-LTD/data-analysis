# web/Dockerfile
# Next.js 生产镜像（multi-stage + standalone）。
# build 时通过 --build-arg 注入 NEXT_PUBLIC_INSFORGE_URL / NEXT_PUBLIC_INSFORGE_ANON_KEY：
# NEXT_PUBLIC_* 会被内联进客户端产物，必须在 next build 之前就位（运行时改不了）。
#
# base 镜像默认走 xuanyuan.run 代理（服务器/国内无 docker hub mirror 时必需）；
# 海外或有 mirror 的环境可用 --build-arg NODE_IMAGE=node:22-alpine 覆盖。
# 由 scripts/deploy.sh 在服务器上 build → push 天翼云 → compose up。

# 服务器（国内）build：base 走 xuanyuan.run 代理、npm 走 npmmirror，均为国内链路。
ARG NODE_IMAGE=caj9ik14016wep.xuanyuan.run/library/node:22-alpine

# ---------- 1. deps：安装依赖 ----------
FROM ${NODE_IMAGE} AS deps
# 国内构建走 npmmirror 加速（官方源极慢）；海外可用
# --build-arg NPM_REGISTRY=https://registry.npmjs.org 覆盖
ARG NPM_REGISTRY=https://registry.npmmirror.com
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm install --registry=$NPM_REGISTRY

# ---------- 2. builder：构建产物 ----------
FROM ${NODE_IMAGE} AS builder
ARG NPM_REGISTRY=https://registry.npmmirror.com
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# NEXT_PUBLIC_* 内联到构建产物，需在 next build 之前作为 ENV 就位
ARG NEXT_PUBLIC_INSFORGE_URL
ARG NEXT_PUBLIC_INSFORGE_ANON_KEY
ARG NEXT_PUBLIC_WECOM_CORP_ID
ARG NEXT_PUBLIC_WECOM_AGENT_ID
ARG NEXT_PUBLIC_WECOM_REDIRECT_URI
ARG NEXT_PUBLIC_CASDOOR_ISSUER
ARG NEXT_PUBLIC_CASDOOR_CLIENT_ID
ARG NEXT_PUBLIC_CASDOOR_REDIRECT_URI
# W1 Task6：catalog 版本戳（catalog 内容 hash）——middleware（edge）构建期内联读 process.env.CATALOG_V，
# 必须在 next build 前就位；值由 scripts/deploy.sh 计算（与 deploy-functions.sh function 侧同树同值）。
ARG CATALOG_V
ENV NEXT_PUBLIC_INSFORGE_URL=$NEXT_PUBLIC_INSFORGE_URL
ENV NEXT_PUBLIC_INSFORGE_ANON_KEY=$NEXT_PUBLIC_INSFORGE_ANON_KEY
ENV NEXT_PUBLIC_WECOM_CORP_ID=$NEXT_PUBLIC_WECOM_CORP_ID
ENV NEXT_PUBLIC_WECOM_AGENT_ID=$NEXT_PUBLIC_WECOM_AGENT_ID
ENV NEXT_PUBLIC_WECOM_REDIRECT_URI=$NEXT_PUBLIC_WECOM_REDIRECT_URI
ENV NEXT_PUBLIC_CASDOOR_ISSUER=$NEXT_PUBLIC_CASDOOR_ISSUER
ENV NEXT_PUBLIC_CASDOOR_CLIENT_ID=$NEXT_PUBLIC_CASDOOR_CLIENT_ID
ENV NEXT_PUBLIC_CASDOOR_REDIRECT_URI=$NEXT_PUBLIC_CASDOOR_REDIRECT_URI
ENV CATALOG_V=$CATALOG_V
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build

# ---------- 3. runner：最小运行镜像 ----------
FROM ${NODE_IMAGE} AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
ENV HOSTNAME=0.0.0.0
# CATALOG_V 随镜像固化（node 运行时侧读取兜底——API 路由 process.env.CATALOG_V；ARG 作用域每阶段独立需重声明）
ARG CATALOG_V
ENV CATALOG_V=$CATALOG_V
# standalone 产物自带最小 node_modules 与 server.js
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/public ./public
EXPOSE 3000
CMD ["node", "server.js"]
