CREATE TABLE finance_workspaces(
 org_id uuid NOT NULL,company_id uuid NOT NULL,period text NOT NULL CHECK(period ~ '^20[0-9]{2}-(0[1-9]|1[0-2])$'),
 state jsonb NOT NULL DEFAULT '{}',version integer NOT NULL DEFAULT 1,updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(company_id,period),FOREIGN KEY(org_id,company_id) REFERENCES companies(org_id,id)
);
ALTER TABLE finance_workspaces ENABLE ROW LEVEL SECURITY;
CREATE POLICY scope ON finance_workspaces USING(org_id=(SELECT actor_org()) AND company_id IN(SELECT visible_company_ids()))
 WITH CHECK(org_id=(SELECT actor_org()) AND company_id IN(SELECT visible_company_ids()) AND (SELECT actor_role())<>'viewer');
GRANT SELECT,INSERT,UPDATE ON finance_workspaces TO zy_app;
ALTER TABLE user_preferences ADD COLUMN version integer NOT NULL DEFAULT 1;
INSERT INTO schema_migrations(version) VALUES(5);
