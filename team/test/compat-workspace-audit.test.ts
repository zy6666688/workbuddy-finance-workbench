import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import argon2 from "argon2";
import { buildServer } from "../src/server.js";
import { pool } from "../src/core.js";

const enabled = process.env.TEAM_TEST_ACCEPT === "1";
const admin = enabled
  ? new Pool({ connectionString: process.env.ADMIN_DATABASE_URL })
  : null;
let app: Awaited<ReturnType<typeof buildServer>>;
after(async () => {
  await app?.close();
  await pool.end();
  await admin?.end();
});

test(
  "real PostgreSQL: original workspace file identity and preference compatibility",
  { skip: !enabled },
  async () => {
    app = await buildServer();
    await app.ready();
    const org = randomUUID(),
      uid = randomUUID(),
      reviewer = randomUUID(),
      cid = randomUUID(),
      second = randomUUID();
    const username = "compat_" + uid,
      password = "Synthetic-Compat!2026";
    await admin!.query("INSERT INTO organizations VALUES($1,$2)", [
      org,
      "兼容性合成验收",
    ]);
    await admin!.query(
      "INSERT INTO users(id,org_id,username,name,password_hash,role,must_change_password) VALUES($1,$2,$3,$4,$5,'owner',false)",
      [uid, org, username, "虚构负责人", await argon2.hash(password)],
    );
    await admin!.query(
      "INSERT INTO users(id,org_id,username,name,password_hash,role,must_change_password) VALUES($1,$2,$3,$4,$5,'owner',false)",
      [
        reviewer,
        org,
        "compat_" + reviewer,
        "虚构复核",
        await argon2.hash(password),
      ],
    );
    for (const id of [cid, second])
      await admin!.query(
        "INSERT INTO companies(id,org_id,code,name) VALUES($1,$2,$3,$4)",
        [id, org, id, "虚构兼容客户"],
      );
    const login = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { username, password },
    });
    assert.equal(login.statusCode, 200, login.body);
    const headers = {
      cookie: login.headers["set-cookie"]!.toString().split(";")[0],
      "x-csrf-token": login.json().csrf,
    };
    async function req(path: string, body?: any, expected = 200) {
      const r = await app.inject({
        method: body === undefined ? "GET" : "POST",
        url: "/api/v1" + path,
        headers,
        payload: body,
      });
      assert.equal(r.statusCode, expected, `${path}: ${r.body}`);
      return r.json();
    }
    // These are real uploads, so restore checks never see index-only files.
    for (const companyId of [cid, second]) {
      const o = await req("/orders", {
        companyId,
        period: "2026-10",
        dueDate: "2026-11-10",
        assigneeId: uid,
        reviewerId: reviewer,
      });
      const orderId = o.id;
      for (const kind of ["source", "result"]) {
        const d = await req("/orders/" + orderId);
        const boundary = "compatBoundary";
        const r = await app.inject({
          method: "POST",
          url: `/api/v1/orders/${orderId}/files?kind=${kind}&version=${d.version}${kind === "result" ? "&origin=manual" : ""}`,
          headers: {
            ...headers,
            "content-type": `multipart/form-data; boundary=${boundary}`,
          },
          payload: Buffer.from(
            `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="same.csv"\r\nContent-Type: text/csv\r\n\r\namount\n1.00\n\r\n--${boundary}--\r\n`,
          ),
        });
        assert.equal(r.statusCode, 200, r.body);
      }
    }
    const a = await req(`/companies/${cid}/files?period=2026-10`);
    const b = await req(`/companies/${second}/files?period=2026-10`);
    assert.equal(a.length, 2);
    assert.equal(b.length, 2);
    assert.equal(
      new Set([...a, ...b].map((f) => f.relative)).size,
      4,
      "React identity and per-account file pins must not collide by name/kind/company",
    );
    assert.deepEqual(await req(`/companies/${cid}/files?period=2026-11`), []);

    await req("/preferences/desk", {
      version: 0,
      key: "favorites",
      value: ["bank-reconcile"],
    });
    let p = await req("/preferences");
    assert.deepEqual(p.favorites, p.desk.favorites);
    await req("/preferences/desk", {
      version: p._version,
      key: "pinnedFiles",
      value: [a[0].relative],
    });
    p = await req("/preferences");
    const oldVersion = p._version;
    await req("/preferences", {
      version: oldVersion,
      theme: "sand",
      favorites: ["budget-variance"],
      recent: [],
    });
    p = await req("/preferences");
    assert.equal(p._version, oldVersion + 1);
    assert.deepEqual(
      p.desk.pinnedFiles,
      [a[0].relative],
      "legacy preferences entry must preserve file pins",
    );
    assert.deepEqual(p.desk.favorites, ["budget-variance"]);
    assert.equal(p.desk.theme, "sand");
    await req(
      "/preferences/desk",
      { version: oldVersion, key: "theme", value: "night" },
      409,
    );
  },
);
