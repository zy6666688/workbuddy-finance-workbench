import { z } from "zod";
import { uuid, period, type Actor } from "./core.js";
import type { PoolClient } from "pg";
import { literalContains } from "./search.js";

const stages = [
  "collecting",
  "checking",
  "processing",
  "review",
  "delivery",
  "archived",
] as const;
const query = z.object({
  companyId: z.union([uuid, z.literal("")]).optional(),
  period: z.union([period, z.literal("")]).optional(),
  status: z.enum(["", ...stages]).default(""),
  scope: z.enum(["all", "handling", "reviewing"]).default("all"),
  attention: z.enum(["", "missing", "overdue", "dueSoon"]).default(""),
  overdue: z.enum(["true", "false"]).optional(),
  search: z.string().max(100).default(""),
  sort: z.enum(["deadline", "updated", "company"]).default("deadline"),
  limit: z.coerce.number().int().min(1).max(100).default(30),
  offset: z.coerce.number().int().min(0).max(1000000).default(0),
});

// Both list and totals run with the caller's RLS identity. Counts cover the full
// authorized scope, never just the current page or a privileged reporting pool.
export async function deliveryRead(
  db: PoolClient,
  actor: Actor,
  input: unknown,
  summary = false,
) {
  const q = query.parse(input),
    attention = q.overdue === "true" ? "overdue" : q.attention;
  const params = [
    q.companyId || null,
    q.period || "",
    q.scope,
    actor.id,
    literalContains(q.search.trim()),
    q.status,
    attention,
  ];
  const base = `WITH scoped AS (
    SELECT w.*, c.name AS company_name, c.code AS company_code,
      a.name AS assignee_name, r.name AS reviewer_name,
      m.required_count, m.received_count, m.missing_count,
      w.status<>'archived' AND w.due_date<(now() AT TIME ZONE 'Asia/Shanghai')::date AS overdue,
      w.status<>'archived' AND w.due_date BETWEEN (now() AT TIME ZONE 'Asia/Shanghai')::date AND (now() AT TIME ZONE 'Asia/Shanghai')::date+7 AS due_soon
    FROM work_orders w JOIN companies c ON c.id=w.company_id
    LEFT JOIN users a ON a.id=w.assignee_id LEFT JOIN users r ON r.id=w.reviewer_id
    CROSS JOIN LATERAL (SELECT
      count(*) FILTER (WHERE (i->>'required')::boolean)::int AS required_count,
      count(*) FILTER (WHERE (i->>'required')::boolean AND (i->>'fileId' IS NOT NULL OR i->>'waiver' IS NOT NULL))::int AS received_count,
      count(*) FILTER (WHERE (i->>'required')::boolean AND i->>'fileId' IS NULL AND i->>'waiver' IS NULL)::int AS missing_count
      FROM jsonb_array_elements(w.checklist) i) m
    WHERE ($1::uuid IS NULL OR w.company_id=$1) AND ($2='' OR w.period=$2)
      AND ($3='all' OR ($3='handling' AND w.assignee_id=$4::uuid) OR ($3='reviewing' AND w.reviewer_id=$4::uuid))
      AND (c.name ILIKE $5 OR c.code ILIKE $5)
  ), filtered AS (SELECT * FROM scoped WHERE ($6='' OR status=$6)
    AND ($7='' OR ($7='overdue' AND overdue) OR ($7='dueSoon' AND due_soon) OR ($7='missing' AND status='collecting' AND missing_count>0)))`;
  if (summary)
    return (
      await db.query(
        `${base} SELECT count(*)::int AS total,
    count(*) FILTER (WHERE overdue)::int AS overdue,
    count(*) FILTER (WHERE due_soon)::int AS due_soon,
    count(*) FILTER (WHERE status='collecting' AND missing_count>0)::int AS missing,
    count(*) FILTER (WHERE status='review')::int AS review,
    count(*) FILTER (WHERE status='delivery')::int AS delivery,
    count(*) FILTER (WHERE status='archived')::int AS archived,
    (SELECT count(*)::int FROM filtered) AS filtered_total,
    (SELECT coalesce(jsonb_object_agg(status,n),'{}') FROM (SELECT status,count(*)::int n FROM scoped GROUP BY status) counts) AS stages
    FROM scoped`,
        params,
      )
    ).rows[0];
  const orderBy = {
    deadline: "(status='archived'),overdue DESC,due_date,id",
    updated: "updated_at DESC,id",
    company: "company_name,id",
  }[q.sort];
  return (
    await db.query(
      `${base} SELECT *,count(*) OVER() AS total FROM filtered ORDER BY ${orderBy} LIMIT $8 OFFSET $9`,
      [...params, q.limit, q.offset],
    )
  ).rows;
}
