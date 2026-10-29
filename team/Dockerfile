FROM node:24-bookworm-slim AS build
WORKDIR /app/team
COPY team/package*.json ./
RUN npm ci
COPY src /app/src
COPY scripts/build-workbuddy-app.mjs /app/scripts/build-workbuddy-app.mjs
COPY team /app/team
RUN npm run typecheck && npm run build

FROM node:24-bookworm-slim
ENV NODE_ENV=production TZ=Asia/Shanghai
WORKDIR /app/team
COPY --from=build /app/team/node_modules ./node_modules
COPY --from=build /app/team/dist ./dist
COPY team/migrations ./migrations
COPY team/package.json ./package.json
USER node
EXPOSE 3000
CMD ["node","dist/server.js"]
