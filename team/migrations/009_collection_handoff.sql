ALTER TABLE files ADD COLUMN upload_key uuid;
ALTER TABLE files ADD COLUMN upload_fingerprint text;
CREATE UNIQUE INDEX file_upload_once ON files(order_id,uploaded_by,upload_key) WHERE upload_key IS NOT NULL;
ALTER TABLE runs ADD COLUMN client_key uuid;
ALTER TABLE runs ADD COLUMN client_fingerprint text;
CREATE UNIQUE INDEX run_create_once ON runs(order_id,created_by,client_key) WHERE client_key IS NOT NULL;
CREATE TABLE material_followups(
 id uuid PRIMARY KEY, org_id uuid NOT NULL, company_id uuid NOT NULL, order_id uuid NOT NULL,
 material_index integer NOT NULL CHECK(material_index BETWEEN 0 AND 39),
 note text NOT NULL, channel text NOT NULL, next_date date, actor_id uuid NOT NULL REFERENCES users,
 created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(org_id,company_id,order_id) REFERENCES work_orders(org_id,company_id,id)
);
CREATE INDEX followup_order ON material_followups(order_id,created_at DESC);
ALTER TABLE material_followups ENABLE ROW LEVEL SECURITY;
CREATE POLICY followup_read ON material_followups FOR SELECT USING(org_id=actor_org() AND can_company(company_id));
CREATE POLICY followup_insert ON material_followups FOR INSERT WITH CHECK(org_id=actor_org() AND can_company(company_id) AND actor_role()<>'viewer' AND actor_id=actor_id());
GRANT SELECT,INSERT ON material_followups TO zy_app;
INSERT INTO schema_migrations(version) VALUES(9);
