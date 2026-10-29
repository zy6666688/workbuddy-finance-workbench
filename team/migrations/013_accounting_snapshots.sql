CREATE TABLE accounting_snapshots (
 id uuid PRIMARY KEY, org_id uuid NOT NULL, company_id uuid NOT NULL, period text NOT NULL CHECK(period ~ '^20[0-9]{2}-(0[1-9]|1[0-2])$'),
 version integer NOT NULL CHECK(version > 0), payload jsonb NOT NULL, actor_id uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(company_id,period,version), FOREIGN KEY(org_id,company_id) REFERENCES companies(org_id,id), FOREIGN KEY(org_id,actor_id) REFERENCES users(org_id,id)
);
ALTER TABLE accounting_snapshots ENABLE ROW LEVEL SECURITY;
CREATE POLICY scope ON accounting_snapshots USING(org_id=actor_org() AND can_company(company_id)) WITH CHECK(org_id=actor_org() AND can_company(company_id) AND actor_role()<>'viewer' AND actor_id=actor_id());
GRANT SELECT,INSERT ON accounting_snapshots TO zy_app;
INSERT INTO schema_migrations(version) VALUES(13);
