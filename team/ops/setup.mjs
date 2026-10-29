import { randomBytes } from "node:crypto";
import { writeFile, mkdir } from "node:fs/promises";
const secret = () => randomBytes(24).toString("hex");
await mkdir(".data/backups", { recursive: true });
await writeFile(
  ".env",
  `DB_PASSWORD=${secret()}\nAPP_DB_PASSWORD=${secret()}\nQUEUE_DB_PASSWORD=${secret()}\nBOOTSTRAP_USER=owner\nBOOTSTRAP_PASSWORD=${secret()}\nORG_NAME=ZY代账团队\nAPP_ORIGIN=http://localhost:8080\nCOOKIE_SECURE=false\nBIND_ADDRESS=127.0.0.1\nPORT=8080\nBACKUP_PATH=./.data/backups\n`,
  { flag: "wx", mode: 0o600 },
);
console.log(
  "已创建 .env；初始账号 owner，初始密码请在本机 .env 的 BOOTSTRAP_PASSWORD 项查看。首次登录后必须修改。请勿提交或分享该文件。",
);
