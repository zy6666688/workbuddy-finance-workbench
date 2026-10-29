CREATE TABLE invoice_requests (
 id uuid PRIMARY KEY, org_id uuid NOT NULL, company_id uuid NOT NULL, order_id uuid NOT NULL,
 business_ref text NOT NULL, actor_id uuid NOT NULL, request_key uuid NOT NULL, fingerprint text NOT NULL,
 input_revision integer NOT NULL CHECK(input_revision>0), source_files jsonb NOT NULL,
 payload jsonb NOT NULL, checks jsonb NOT NULL,
 status text NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','ready','withdrawn')),
 version integer NOT NULL DEFAULT 1 CHECK(version>0),
 confirmed_by uuid, confirmed_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(org_id,company_id,order_id) REFERENCES work_orders(org_id,company_id,id),
 FOREIGN KEY(org_id,actor_id) REFERENCES users(org_id,id),
 FOREIGN KEY(org_id,confirmed_by) REFERENCES users(org_id,id),
 UNIQUE(order_id,actor_id,request_key),
 UNIQUE(org_id,company_id,id),
 CHECK((status='ready')=(confirmed_by IS NOT NULL AND confirmed_at IS NOT NULL))
);
-- A business reference denotes one intended invoice, including a part number for split billing.
CREATE UNIQUE INDEX invoice_request_business ON invoice_requests(company_id,business_ref) WHERE status<>'withdrawn';
CREATE INDEX invoice_request_order ON invoice_requests(order_id,created_at DESC);
ALTER TABLE invoice_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE invoice_requests FORCE ROW LEVEL SECURITY;
CREATE POLICY scope ON invoice_requests USING(org_id=actor_org() AND can_company(company_id))
 WITH CHECK(org_id=actor_org() AND can_company(company_id) AND actor_role()<>'viewer');
GRANT SELECT,INSERT ON invoice_requests TO zy_app;
GRANT UPDATE(status,version,confirmed_by,confirmed_at,payload,checks,source_files,input_revision) ON invoice_requests TO zy_app;
CREATE TABLE invoice_request_revisions (
 id uuid PRIMARY KEY, request_id uuid NOT NULL,
 org_id uuid NOT NULL, company_id uuid NOT NULL, actor_id uuid NOT NULL,
 request_key uuid NOT NULL, fingerprint text NOT NULL, version integer NOT NULL,
 snapshot jsonb NOT NULL, reason text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(request_id,actor_id,request_key), UNIQUE(request_id,version),
 FOREIGN KEY(org_id,company_id) REFERENCES companies(org_id,id),
 FOREIGN KEY(org_id,company_id,request_id) REFERENCES invoice_requests(org_id,company_id,id),
 FOREIGN KEY(org_id,actor_id) REFERENCES users(org_id,id)
);
ALTER TABLE invoice_request_revisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE invoice_request_revisions FORCE ROW LEVEL SECURITY;
CREATE POLICY scope ON invoice_request_revisions USING(org_id=actor_org() AND can_company(company_id))
 WITH CHECK(org_id=actor_org() AND can_company(company_id) AND actor_role()<>'viewer' AND actor_id=actor_id());
GRANT SELECT,INSERT ON invoice_request_revisions TO zy_app;
INSERT INTO schema_migrations(version) VALUES(15);
