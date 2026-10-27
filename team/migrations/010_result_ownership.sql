ALTER TABLE work_orders ADD COLUMN input_revision integer NOT NULL DEFAULT 1 CHECK(input_revision>0);
ALTER TABLE runs ADD COLUMN input_revision integer NOT NULL DEFAULT 1 CHECK(input_revision>0);
ALTER TABLE runs ADD COLUMN active boolean NOT NULL DEFAULT true;
ALTER TABLE runs ADD COLUMN supersedes_run_id uuid;
ALTER TABLE runs DROP CONSTRAINT runs_status_check;
ALTER TABLE runs ADD CONSTRAINT runs_status_check CHECK(status IN ('external','returned','stale','cancelled'));
ALTER TABLE runs ADD CONSTRAINT runs_scope_id UNIQUE(org_id,company_id,order_id,id);
ALTER TABLE runs ADD CONSTRAINT runs_supersedes_scope FOREIGN KEY(org_id,company_id,order_id,supersedes_run_id) REFERENCES runs(org_id,company_id,order_id,id);
CREATE UNIQUE INDEX runs_single_revision ON runs(supersedes_run_id) WHERE supersedes_run_id IS NOT NULL;
UPDATE runs r SET active=(r.revision=w.revision) FROM work_orders w WHERE w.id=r.order_id;
ALTER TABLE files ADD CONSTRAINT files_result_scope UNIQUE(org_id,company_id,order_id,id,kind);
CREATE TABLE result_origins(
 file_id uuid PRIMARY KEY, org_id uuid NOT NULL,company_id uuid NOT NULL,order_id uuid NOT NULL,
 file_kind text NOT NULL DEFAULT 'result' CHECK(file_kind='result'),
 origin text NOT NULL CHECK(origin IN ('workbuddy','manual','excluded','legacy_archive')),
 run_id uuid, input_revision integer NOT NULL CHECK(input_revision>0),
 method text NOT NULL CHECK(method IN ('upload','legacy_auto','manual_resolution','archive_index')),
 actor_id uuid, reason text NOT NULL DEFAULT '', created_at timestamptz NOT NULL DEFAULT now(),
 CHECK((origin='workbuddy')=(run_id IS NOT NULL)),
 FOREIGN KEY(org_id,company_id,order_id,file_id,file_kind) REFERENCES files(org_id,company_id,order_id,id,kind),
 FOREIGN KEY(org_id,company_id,order_id,run_id) REFERENCES runs(org_id,company_id,order_id,id),
 FOREIGN KEY(org_id,actor_id) REFERENCES users(org_id,id)
);
CREATE INDEX result_origins_order ON result_origins(order_id,origin,run_id);
CREATE INDEX result_origins_run ON result_origins(run_id,file_id) WHERE run_id IS NOT NULL;
-- Archive contents, approvals, file rows and old execution receipts stay intact.
-- This side-table only identifies their legacy provenance for future reads.
INSERT INTO result_origins(file_id,org_id,company_id,order_id,origin,input_revision,method)
 SELECT f.id,f.org_id,f.company_id,f.order_id,'legacy_archive',w.input_revision,'archive_index'
 FROM files f JOIN work_orders w ON w.id=f.order_id WHERE f.kind='result' AND w.status='archived';
-- Only an explicit, unique reference is evidence of ownership. Never infer it
-- from filenames, uploader, creation time or proximity to another operation.
WITH refs AS (
 SELECT f.id AS file_id,(array_agg(DISTINCT r.id))[1] AS run_id
 FROM files f JOIN work_orders w ON w.id=f.order_id
 JOIN runs r ON r.org_id=f.org_id AND r.company_id=f.company_id AND r.order_id=f.order_id AND f.id=ANY(r.result_files)
 WHERE f.kind='result' AND w.status<>'archived' GROUP BY f.id HAVING count(DISTINCT r.id)=1
)
INSERT INTO result_origins(file_id,org_id,company_id,order_id,origin,run_id,input_revision,method)
 SELECT f.id,f.org_id,f.company_id,f.order_id,'workbuddy',r.id,r.input_revision,'legacy_auto'
 FROM refs x JOIN files f ON f.id=x.file_id JOIN runs r ON r.id=x.run_id;
ALTER TABLE result_origins ENABLE ROW LEVEL SECURITY;
CREATE POLICY origin_read ON result_origins FOR SELECT USING(org_id=actor_org() AND can_company(company_id));
CREATE POLICY origin_insert ON result_origins FOR INSERT WITH CHECK(org_id=actor_org() AND can_company(company_id) AND actor_role()<>'viewer' AND actor_id=actor_id() AND origin<>'legacy_archive' AND method IN ('upload','manual_resolution'));
GRANT SELECT,INSERT ON result_origins TO zy_app;
INSERT INTO schema_migrations(version) VALUES(10);
