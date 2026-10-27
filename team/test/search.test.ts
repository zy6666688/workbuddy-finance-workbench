import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
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
  "real PostgreSQL: literal client search, pagination, and immediate scope revocation",
  { skip: !enabled },
  async () => {
    app = await buildServer();
    await app.ready();
    const org = randomUUID(),
      foreignOrg = randomUUID(),
      user = randomUUID();
    const username = "search_" + user,
      password = "Synthetic-Search!2026";
    await admin!.query("INSERT INTO organizations VALUES($1,$2),($3,$4)", [
      org,
      "搜索验收机构",
      foreignOrg,
      "搜索隔离机构",
    ]);
    await admin!.query(
      "INSERT INTO users(id,org_id,username,name,password_hash,role,must_change_password) VALUES($1,$2,$3,$4,$5,'reviewer',false)",
      [user, org, username, "搜索验收复核员", await argon2.hash(password)],
    );
    const names = [
      "税率100%贸易",
      "AC_01公司",
      "ACX01公司",
      "Path\\财务",
      "O'Reilly科技",
      ...Array.from(
        { length: 32 },
        (_, i) => `分页客户${String(i).padStart(2, "0")}`,
      ),
    ];
    const ids: string[] = [];
    for (const name of names) {
      const id = randomUUID();
      ids.push(id);
      await admin!.query(
        "INSERT INTO companies(id,org_id,code,name) VALUES($1,$2,$3,$4)",
        [id, org, "CODE-" + ids.length, name],
      );
      await admin!.query("INSERT INTO memberships VALUES($1,$2,$3)", [
        org,
        id,
        user,
      ]);
      await admin!.query(
        "INSERT INTO work_orders(id,org_id,company_id,period,status,reviewer_id,due_date,checklist) VALUES($1,$2,$3,'2026-10','review',$4,'2026-11-10','[]')",
        [randomUUID(), org, id, user],
      );
    }
    const hidden = randomUUID(),
      foreign = randomUUID();
    for (const [id, oid] of [
      [hidden, org],
      [foreign, foreignOrg],
    ])
      await admin!.query(
        "INSERT INTO companies(id,org_id,code,name) VALUES($1,$2,$3,'税率100%贸易')",
        [id, oid, id],
      );
    const login = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { username, password },
    });
    assert.equal(login.statusCode, 200, login.body);
    const cookie = login.headers["set-cookie"]!.toString().split(";")[0];
    async function get(
      path: string,
      search: string,
      extra: Record<string, string> = {},
    ) {
      const params = new URLSearchParams({
        period: "2026-10",
        search,
        limit: "100",
        ...(path === "/reviews/queue" ? { queue: "review" } : {}),
        ...extra,
      });
      const response = await app.inject({
        method: "GET",
        url: "/api/v1" + path + "?" + params,
        headers: { cookie },
      });
      assert.equal(response.statusCode, 200, response.body);
      return response.json();
    }
    const paths = ["/companies", "/clients", "/reviews/queue", "/orders"];
    const rows = (body: any) => (Array.isArray(body) ? body : body.rows);
    for (const [term, expectedName] of [
      ["%", names[0]],
      ["_", names[1]],
      ["\\", names[3]],
      ["O'Reilly", names[4]],
      ["  ac_01  ", names[1]],
      ["CODE-37", names[36]],
    ]) {
      for (const path of paths) {
        const result = rows(await get(path, term));
        assert.equal(
          result.length,
          1,
          `${path}: literal search ${JSON.stringify(term)} should match one client`,
        );
        assert.equal(result[0].company_name || result[0].name, expectedName);
      }
    }
    for (const path of paths) {
      assert.equal(
        rows(await get(path, "   ")).length,
        37,
        path + " empty query",
      );
      assert.equal(
        rows(await get(path, "does-not-exist")).length,
        0,
        path + " no result",
      );
      const first = rows(await get(path, "", { limit: "30" }));
      const second = rows(await get(path, "", { limit: "30", offset: "30" }));
      assert.equal(first.length, 30);
      assert.equal(second.length, 7);
      assert.equal(
        new Set([...first, ...second].map((r: any) => r.id)).size,
        37,
        path + " pagination without duplicates",
      );
    }
    const outsidePage = await get("/clients", "", { offset: "90" });
    assert.equal(outsidePage.filtered_total, 37);
    assert.deepEqual(outsidePage.rows, []);
    for (const companyId of [hidden, foreign]) {
      assert.deepEqual((await get("/clients", "", { companyId })).rows, []);
      assert.deepEqual(
        (await get("/reviews/queue", "", { companyId })).rows,
        [],
      );
    }
    // The history list is bounded, but the selected accounting period must not
    // be mistaken for an unstarted month when it falls outside those 24 rows.
    const oldOrder = randomUUID();
    await admin!.query(
      "INSERT INTO work_orders(id,org_id,company_id,period,status,due_date,checklist) VALUES($1,$2,$3,'2022-10','archived','2022-11-10','[]')",
      [oldOrder, org, ids[1]],
    );
    for (let i = 0; i < 24; i++) {
      const month = `${2023 + Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, "0")}`;
      await admin!.query(
        "INSERT INTO work_orders(id,org_id,company_id,period,status,due_date,checklist) VALUES($1,$2,$3,$4,'archived','2025-01-10','[]')",
        [randomUUID(), org, ids[1], month],
      );
    }
    const history = await get(`/clients/${ids[1]}`, "", { period: "2022-10" });
    assert.equal(history.orders.length, 24);
    assert.ok(!history.orders.some((o: any) => o.id === oldOrder));
    assert.equal(history.current_order.id, oldOrder);
    assert.equal(history.current_order.status, "archived");
    await admin!.query(
      "DELETE FROM memberships WHERE company_id=$1 AND user_id=$2",
      [ids[0], user],
    );
    for (const path of paths)
      assert.equal(
        rows(await get(path, "%")).length,
        0,
        path + " revoked membership must take effect in existing session",
      );
    const owner = randomUUID(),
      ownerUsername = "search_owner_" + owner;
    await admin!.query(
      "INSERT INTO users(id,org_id,username,name,password_hash,role,must_change_password) VALUES($1,$2,$3,$4,$5,'owner',false)",
      [
        owner,
        org,
        ownerUsername,
        "搜索验收负责人",
        await argon2.hash(password),
      ],
    );
    const resultsDir = process.env.RESULTS_DIR || "/results";
    await mkdir(resultsDir, { recursive: true });
    await writeFile(
      resultsDir + "/search-browser.json",
      JSON.stringify(
        {
          owner: { username: ownerUsername, password },
          reviewer: { username, password },
          org,
          companyIds: ids,
          oldOrder,
          ownerClientCount: 38,
          reviewerClientCount: 36,
        },
        null,
        2,
      ),
    );
  },
);
