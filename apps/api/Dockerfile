# NOT YET TESTED (Docker was unavailable on the development machine). Build from the repo root:
#   docker build -f apps/api/Dockerfile -t safelybuild-api .
FROM node:24-slim
WORKDIR /repo
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
RUN npm ci --workspace apps/api --include-workspace-root=false
COPY apps/api apps/api
COPY db db
COPY services/inference/samples services/inference/samples
ENV NODE_ENV=production STORAGE_DIR=/data
WORKDIR /repo/apps/api
EXPOSE 4000
CMD ["node", "src/server.js"]
