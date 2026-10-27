import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { Pool } from "pg";
const enabled = process.env.TEAM_TEST_ACCEPT === "1";
test(
  "ownership migration preserves archives and approvals; only unique explicit references auto-bind",
  { skip: !enabled },
  async () => {
    const admin = new Pool({
      connectionString: process.env.ADMIN_DATABASE_URL,
    });
    const dbname = "ownership_migration_" + randomUUID().replaceAll("-", ""),
      url = new URL(process.env.ADMIN_DATABASE_URL!);
    url.pathname = "/" + dbname;
    let db: Pool | undefined;
    try {
      await admin.query(`CREATE DATABASE "${dbname}"`);
      db = new Pool({ connectionString: url.toString() });
      for (const name of (await readdir("migrations"))
        .filter((x) => x.endsWith(".sql") && Number(x.split("_")[0]) < 10)
        .sort())
        await db.query(await readFile("migrations/" + name, "utf8"));
      const org = randomUUID(),
        cid = randomUUID(),
        uid = randomUUID(),
        open = randomUUID(),
        archived = randomUUID();
      await db.query("INSERT INTO organizations VALUES($1,$2)", [
        org,
        "仅迁移虚构机构",
      ]);
      await db.query(
        "INSERT INTO users(id,org_id,username,name,password_hash,role) VALUES($1,$2,$3,'测试','unused','owner')",
        [uid, org, uid],
      );
      await db.query(
        "INSERT INTO companies(id,org_id,code,name) VALUES($1,$2,$3,'虚构')",
        [cid, org, cid],
      );
      for (const [id, status, period] of [
        [open, "delivery", "2026-10"],
        [archived, "archived", "2026-09"],
      ])
        await db.query(
          "INSERT INTO work_orders(id,org_id,company_id,period,status,assignee_id,due_date,checklist) VALUES($1,$2,$3,$4,$5,$6,'2026-11-10','[]')",
          [id, org, cid, period, status, uid],
        );
      const unique = randomUUID(),
        ambiguous = randomUUID(),
        orphan = randomUUID(),
        archiveFile = randomUUID(),
        r1 = randomUUID(),
        r2 = randomUUID(),
        r3 = randomUUID();
      for (const [id, oid] of [
        [unique, open],
        [ambiguous, open],
        [orphan, open],
        [archiveFile, archived],
      ])
        await db.query(
          "INSERT INTO files(id,org_id,company_id,order_id,name,kind,category,size,sha256,storage_key,uploaded_by,version) VALUES($1,$2,$3,$4,'same.txt','result','成果',5,'fixed',$6,$5,1)",
          [id, org, cid, oid, uid, id],
        );
      for (const [id, oid, files] of [
        [r1, open, [unique, ambiguous]],
        [r2, open, [ambiguous]],
        [r3, archived, [archiveFile]],
      ])
        await db.query(
          "INSERT INTO runs(id,org_id,company_id,order_id,workflow_id,input_files,result_files,status,revision,created_by) VALUES($1,$2,$3,$4,'test','[]',$5,'returned',1,$6)",
          [id, org, cid, oid, files, uid],
        );
      for (const [oid, file] of [
        [open, unique],
        [archived, archiveFile],
      ]) {
        const snapshot = {
          files: [{ id: file, name: "same.txt", version: 1, sha256: "fixed" }],
          revision: 1,
          at: "2026-10-01T00:00:00.000Z",
          submittedBy: uid,
        };
        await db.query("UPDATE work_orders SET submission=$1 WHERE id=$2", [
          JSON.stringify(snapshot),
          oid,
        ]);
        await db.query(
          "INSERT INTO reviews(id,org_id,company_id,order_id,revision,actor_id,action,reason,snapshot) VALUES($1,$2,$3,$4,1,$5,'approve','旧独立结论',$6)",
          [randomUUID(), org, cid, oid, uid, JSON.stringify(snapshot)],
        );
      }
      const queries = [
        "SELECT id,status,version,revision,submission FROM work_orders ORDER BY id",
        "SELECT * FROM files ORDER BY id",
        "SELECT * FROM reviews ORDER BY id",
        "SELECT id,status,input_files,result_files,check_result,version,revision FROM runs ORDER BY id",
      ];
      const before = await Promise.all(
        queries.map((q) => db!.query(q).then((r) => r.rows)),
      );
      await db.query(
        await readFile("migrations/010_result_ownership.sql", "utf8"),
      );
      for (let i = 0; i < queries.length; i++)
        assert.deepEqual((await db.query(queries[i])).rows, before[i]);
      const origins = (
        await db.query(
          "SELECT file_id,origin,run_id,method FROM result_origins",
        )
      ).rows;
      assert.deepEqual(
        origins.find((x) => x.file_id === unique),
        {
          file_id: unique,
          origin: "workbuddy",
          run_id: r1,
          method: "legacy_auto",
        },
      );
      assert.equal(
        origins.find((x) => x.file_id === archiveFile).origin,
        "legacy_archive",
      );
      assert.equal(
        origins.some((x) => [ambiguous, orphan].includes(x.file_id)),
        false,
        "zero/multiple references need human confirmation",
      );
      await assert.rejects(
        db.query(
          "INSERT INTO result_origins(file_id,org_id,company_id,order_id,origin,run_id,input_revision,method) VALUES($1,$2,$3,$4,'workbuddy',$5,1,'legacy_auto')",
          [unique, org, cid, open, r2],
        ),
        (e: any) => e.code === "23505",
      );
    } finally {
      await db?.end();
      // Only the uniquely named database generated by this test is removed.
      await admin.query(`DROP DATABASE IF EXISTS "${dbname}"`);
      await admin.end();
    }
  },
);
