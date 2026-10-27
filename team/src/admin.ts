import { Pool } from "pg";
import { readFile, readdir, mkdir, writeFile } from "node:fs/promises";
import { randomUUID, randomBytes } from "node:crypto";
import argon2 from "argon2";
import path from "node:path";

const command = process.argv[2];
const db = new Pool({ connectionString: process.env.ADMIN_DATABASE_URL });
try {
  if (command === "migrate") {
    const c = await db.connect();
    try {
      await c.query("SELECT pg_advisory_lock(374810)");
      await c.query(
        "CREATE TABLE IF NOT EXISTS schema_migrations(version integer PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())",
      );
      for (const f of (await readdir("migrations"))
        .filter((f) => f.endsWith(".sql"))
        .sort()) {
        const version = Number(f.split("_")[0]);
        if (
          (
            await c.query("SELECT 1 FROM schema_migrations WHERE version=$1", [
              version,
            ])
          ).rowCount
        )
          continue;
        await c.query("BEGIN");
        try {
          await c.query(await readFile(path.join("migrations", f), "utf8"));
          await c.query("COMMIT");
          console.log("applied", f);
        } catch (e) {
          await c.query("ROLLBACK");
          throw e;
        }
      }
    } finally {
      await c.query("SELECT pg_advisory_unlock(374810)");
      c.release();
    }
  } else if (command === "bootstrap") {
    if ((await db.query("SELECT 1 FROM organizations LIMIT 1")).rowCount) {
      if (process.argv.includes("--if-empty")) {
        console.log("机构已初始化，保持不变");
        process.exit(0);
      }
      throw new Error("机构已初始化，拒绝覆盖");
    }
    const username = process.env.BOOTSTRAP_USER || "owner",
      password = process.env.BOOTSTRAP_PASSWORD;
    if (!password || password.length < 12)
      throw new Error("请通过 BOOTSTRAP_PASSWORD 提供至少12位初始密码");
    const org = randomUUID(),
      id = randomUUID();
    const c = await db.connect();
    try {
      await c.query("BEGIN");
      await c.query("INSERT INTO organizations(id,name) VALUES($1,$2)", [
        org,
        process.env.ORG_NAME || "ZY 代账团队",
      ]);
      await c.query(
        "INSERT INTO users(id,org_id,username,name,role,password_hash) VALUES($1,$2,$3,'负责人','owner',$4)",
        [id, org, username, await argon2.hash(password)],
      );
      await c.query("COMMIT");
      console.log("负责人账号已创建，首次登录需修改密码");
    } catch (e) {
      await c.query("ROLLBACK");
      throw e;
    } finally {
      c.release();
    }
  } else throw new Error("Usage: admin migrate | bootstrap");
} finally {
  await db.end();
}
