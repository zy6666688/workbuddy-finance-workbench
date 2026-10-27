# 部署与运维

## 部署结构

Docker Compose 包含 db、migrate、app、worker、gateway、backup。数据库没有宿主机端口。应用仅经网关访问；默认绑定 127.0.0.1。文件和数据库分别使用命名卷，`.env` 保存随机生成的部署凭据，备份输出到独立主机挂载目录。

初次启动参见 [README](../README.md)。不要用 `docker compose down -v` 停机，它会删除持久化卷；正常停止使用 `docker compose stop`，重启使用 `docker compose up -d`。

Node 为 24，数据库为 PostgreSQL 17，时区 Asia/Shanghai。日期字段使用业务日字符串，避免转为 UTC 后提前一天。资源大小和性能以实际验收报告为准，首版单机不承诺高可用。

## 正式团队访问

为服务器配置域名、有效证书和防火墙，使用 HTTPS。提供可选覆盖配置：

1. 在 `.env` 设置 `PUBLIC_HOST=finance.example.com`，替换成实际域名；域名指向服务器。
2. 运行 `docker compose -f compose.yaml -f compose.https.yaml up -d`。这会把网关发布到 80/443，自动申请证书，并开启安全会话 Cookie。
3. 验证 HTTPS 后再向员工分发地址。不要公开 PostgreSQL、文件目录、备份目录或 Docker 管理接口。

也可接入机构既有 HTTPS 代理：保持默认本机绑定，设置 `APP_ORIGIN=https://实际域名`、`COOKIE_SECURE=true`，由既有代理转发。不要为绕过证书报错关闭浏览器或服务器的证书校验。

## 备份

backup 服务启动时执行一次，之后每 24 小时执行。每个恢复点包含 `database.dump`、`files.tar.gz`、`SHA256SUMS` 和 `COMPLETE`；不完整目录不能恢复。运行页面显示最近状态。

```sh
docker compose run --rm --no-deps backup bash /backup.sh
```

`.env` 中 `BACKUP_PATH` 指向独立挂载目录，默认 `.data/backups`。每日备份默认保留最近 30 个有成功备份的日期；同日手动恢复点一并保留，业务归档不自动删除。

数据库快照先于文件复制；已提交文件不可覆盖或删除，因此快照引用的文件会包含在随后的文件备份中。可能附带快照之后新上传的未引用文件，不会变成可用业务记录。上传失败的孤立文件不会通过接口提供。

把完成的整个恢复点和必要部署配置复制到另一台机器或加密对象存储。只同步含 COMPLETE 的目录，复制后重新验证 SHA256SUMS。备份含客户资料，应限制读取并对异机介质加密。当前同机备份不代表灾难恢复能力。

## 空环境恢复

1. 停止新环境应用和 Worker，不允许业务写入。
2. 在新环境准备空数据库、空文件卷，并创建 `zy_app`、`zy_queue` 角色（使用 `ops/init-db.sh`）。不要先运行业务迁移或初始化机构。
3. 用 PostgreSQL 17 客户端挂载恢复点、空文件卷和 `ops/restore.sh`，设置 PGHOST、PGDATABASE、PGUSER、PGPASSWORD 后执行：

```sh
bash /restore.sh /backups/恢复点目录
```

恢复脚本检查摘要、拒绝覆盖非空数据库或文件目录，保留数据库对象所有权及权限。运行数据库恢复的账号需要创建表、函数、策略并指定原所有者的权限。恢复账号只用于运维，不提供给应用。

4. 核对账号、授权、月度状态、审批记录和每个文件摘要，检查 zy_app 没有超级用户、BYPASSRLS 或业务表所有权，pgboss 队列对象归 zy_queue。
5. 用两名测试员工验证公司隔离和下载，然后启动 Worker、应用及网关，确认队列可处理后切换入口。

仓库提供可重复的真实恢复演练：`node ops/test-recovery.mjs`。它只操作 `zy-finance-test`，在新数据库和新文件卷恢复，对比业务表摘要、全部文件摘要、账号授权和队列所有权；保留恢复环境供检查。

## 升级与回滚

每次升级前手动备份并确认 COMPLETE，记录当前 Git 提交和镜像标签。先在测试环境恢复一份备份，升级并验收，再正式升级。

```sh
docker compose build
docker compose stop app worker
docker compose run --rm migrate
docker compose up -d
docker compose ps
```

迁移文件按编号只执行一次，使用事务和数据库锁。已发布迁移不回写，新增兼容上一版的迁移。应用异常时可先切回上一镜像；不要默认直接降级数据库。破坏性变更需独立数据迁移及恢复方案。

## 排障

- 页面打不开：检查 Docker 引擎、端口、`docker compose ps` 和 app/gateway 日志。
- 登录后来源校验失败：APP_ORIGIN 必须与地址栏协议、域名和端口完全一致。
- 后台任务不动：检查 worker 日志、公司授权、员工启用状态。队列失败会有限重试；处理中断事务会回滚，重复执行不产生重复业务成果。
- 文件完整性报错：停止引用该文件，检查磁盘或从完整恢复点恢复；不要直接修改摘要绕过校验。
- Docker Desktop 报 secrets engine 的 `engine.sock` 无法访问：先退出 Docker，备份并重命名仅含失效 socket 的 secrets-engine/run 目录再启动；不要直接恢复出厂设置。该修复应在确认具体故障目录后由运维执行。
- 更多 Worker：`docker compose up -d --scale worker=2`。单台机器仍是共同故障点。

服务日志默认不记录 Cookie、密码和 CSRF。运维仍应限制容器日志、`.env`、Docker Socket 与备份访问。
