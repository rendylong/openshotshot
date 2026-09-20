# 构建 Vite 前端产物。
FROM node:22-alpine AS web-build

WORKDIR /app/web
# .npmrc 的 legacy-peer-deps 与仓库约定保持一致，npm ci 依赖它。
COPY .npmrc ./
COPY web/package.json web/package-lock.json ./
RUN npm ci
# vite.config.ts 读取仓库根的 VERSION 注入 __APP_VERSION__。
COPY VERSION /app/VERSION
COPY CHANGELOG.md /app/CHANGELOG.md
COPY web/ ./
RUN npm run build

# 运行镜像：只启动静态前端，AI 请求由浏览器前台直连用户自己的接口。
FROM nginx:1.27-alpine

COPY --from=web-build /app/web/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 3000
