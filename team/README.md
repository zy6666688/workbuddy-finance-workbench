# ZY 财务工作台 · 代账团队版 3.0

面向内部代账团队的浏览器工作台。原 WorkBuddy 插件保持原来的安装方式和本机数据；本目录是独立服务，使用 PostgreSQL 和私有文件卷保存团队业务。

入口：登录 → 客户公司 → 月度交付 → WorkBuddy 任务包 → 独立复核 → 登记交付 → 归档。

## 本机启动

需要 Node.js 24、已启动的 Docker Engine、Docker Compose。首次下载在仓库根目录运行：

```sh
cd team
node ops/setup.mjs
docker compose up -d --build
docker compose ps
```

打开 `http://localhost:8080`。账号是 `owner`，初始密码见本机 `team/.env` 的 `BOOTSTRAP_PASSWORD`。首次登录必须改密。初始化不会覆盖已有机构；setup 不会覆盖已有 `.env`。

端口被占用时，同时修改 `.env` 中的 `PORT` 和 `APP_ORIGIN`，再启动。不要把 `.env`、`.data`、`.test`、备份或真实客户资料提交到 Git。

- [部署、升级、HTTPS 与恢复](docs/DEPLOYMENT.md)
- [员工与负责人操作手册](docs/USER_GUIDE.md)
- [权限、存储、任务和接口设计](docs/ARCHITECTURE.md)
- [资料收集、WorkBuddy 与团队管理](docs/COLLECTION_WORKBUDDY_TEAM.md)
- [WorkBuddy 团队版配置与使用说明](docs/WORKBUDDY_BRIDGE.md)
- [验收方法与结果](docs/ACCEPTANCE.md)

## 本地开发与验收

```sh
npm ci
npm run typecheck
npm test
npm run build
npm audit --omit=dev
```

普通 `npm test` 运行纯校验测试，真实数据库集成测试明确显示跳过。完整验收必须另外运行隔离容器：

```sh
docker compose -p zy-finance-test -f compose.yaml -f compose.test.yaml up -d db migrate app worker gateway
docker compose -p zy-finance-test -f compose.yaml -f compose.test.yaml run --rm acceptance
docker compose -p zy-finance-test -f compose.yaml -f compose.test.yaml run --rm acceptance node test/collection-lifecycle.mjs
docker compose -p zy-finance-test -f compose.yaml -f compose.test.yaml run --rm acceptance node --import tsx test/scale.mjs
node ops/test-worker.mjs
node ops/test-recovery.mjs
```

验收容器需要本目录的 `.env`。只使用 `zy-finance-test` 项目；测试账号、客户和文件全部为合成数据。结果写入 `.test/results`，不包含真实客户信息。容量测试的 10 万条文件记录为索引占位数据，测完清理这一批占位索引，不代表上传了 10 万个文件。

原个人版仍在仓库根目录执行 `npm ci` 和 `npm run verify:release`。团队版不会升级或覆盖原插件的本机存储。
