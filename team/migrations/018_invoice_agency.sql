-- Local agency authorization and offline receipt ledger; no tax-platform credentials.
CREATE TABLE invoice_authorizations (
 id uuid PRIMARY KEY, org_id uuid NOT NULL, company_id uuid NOT NULL, order_id uuid NOT NULL,
 actor_id uuid NOT NULL, request_key uuid NOT NULL, fingerprint text NOT NULL,
 payload jsonb NOT NULL, evidence jsonb NOT NULL,
 status text NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','verified','revoked')),
 version integer NOT NULL DEFAULT 1 CHECK(version>0), reviewed_by uuid, reviewed_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(org_id,company_id,id), UNIQUE(order_id,actor_id,request_key),
 FOREIGN KEY(org_id,company_id,order_id) REFERENCES work_orders(org_id,company_id,id),
 FOREIGN KEY(org_id,actor_id) REFERENCES users(org_id,id),
 FOREIGN KEY(org_id,reviewed_by) REFERENCES users(org_id,id),
 CHECK(status<>'verified' OR (reviewed_by IS NOT NULL AND reviewed_at IS NOT NULL AND reviewed_by<>actor_id))
);
ALTER TABLE invoice_authorizations ENABLE ROW LEVEL SECURITY;
ALTER TABLE invoice_authorizations FORCE ROW LEVEL SECURITY;
CREATE POLICY scope ON invoice_authorizations USING(org_id=actor_org() AND can_company(company_id))
 WITH CHECK(org_id=actor_org() AND can_company(company_id) AND actor_role()<>'viewer');
GRANT SELECT,INSERT ON invoice_authorizations TO zy_app;
GRANT UPDATE(status,version,reviewed_by,reviewed_at) ON invoice_authorizations TO zy_app;
CREATE INDEX invoice_authorization_company ON invoice_authorizations(company_id,created_at DESC,id);
ALTER TABLE invoice_requests ADD COLUMN authorization_id uuid, ADD COLUMN authorization_version integer;
ALTER TABLE invoice_requests ADD FOREIGN KEY(org_id,company_id,authorization_id) REFERENCES invoice_authorizations(org_id,company_id,id);
ALTER TABLE invoice_requests ADD CHECK((authorization_id IS NULL)=(authorization_version IS NULL));
ALTER TABLE invoice_requests ADD CHECK(authorization_version IS NULL OR authorization_version>0);
GRANT UPDATE(authorization_id,authorization_version) ON invoice_requests TO zy_app;

CREATE TABLE invoice_batches (
 id uuid PRIMARY KEY, org_id uuid NOT NULL, actor_id uuid NOT NULL, request_key uuid NOT NULL,
 fingerprint text NOT NULL, title text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(org_id,id), UNIQUE(org_id,actor_id,request_key),
 FOREIGN KEY(org_id,actor_id) REFERENCES users(org_id,id)
);
ALTER TABLE invoice_batches ENABLE ROW LEVEL SECURITY;
ALTER TABLE invoice_batches FORCE ROW LEVEL SECURITY;
CREATE POLICY scope ON invoice_batches USING(org_id=actor_org() AND (actor_id=actor_id() OR actor_role()='owner'))
 WITH CHECK(org_id=actor_org() AND actor_id=actor_id() AND actor_role()<>'viewer');
GRANT SELECT,INSERT ON invoice_batches TO zy_app;
CREATE TABLE invoice_batch_items (
 id uuid PRIMARY KEY, org_id uuid NOT NULL, company_id uuid NOT NULL, order_id uuid NOT NULL,
 batch_id uuid NOT NULL, item_key uuid NOT NULL, request_id uuid,
 status text NOT NULL CHECK(status IN ('prepared','blocked')), error text, payload jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(batch_id,item_key),
 FOREIGN KEY(org_id,batch_id) REFERENCES invoice_batches(org_id,id),
 FOREIGN KEY(org_id,company_id,order_id) REFERENCES work_orders(org_id,company_id,id),
 FOREIGN KEY(org_id,company_id,request_id) REFERENCES invoice_requests(org_id,company_id,id),
 CHECK((status='prepared')=(request_id IS NOT NULL))
);
ALTER TABLE invoice_batch_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE invoice_batch_items FORCE ROW LEVEL SECURITY;
CREATE POLICY scope ON invoice_batch_items USING(org_id=actor_org() AND can_company(company_id))
 WITH CHECK(org_id=actor_org() AND can_company(company_id) AND actor_role()<>'viewer');
GRANT SELECT,INSERT ON invoice_batch_items TO zy_app;
CREATE INDEX invoice_batch_item_order ON invoice_batch_items(order_id,created_at DESC);

CREATE TABLE invoice_result_records (
 record_index bigint GENERATED ALWAYS AS IDENTITY,
 id uuid PRIMARY KEY, org_id uuid NOT NULL, company_id uuid NOT NULL, order_id uuid NOT NULL,
 request_id uuid NOT NULL, actor_id uuid NOT NULL, request_key uuid NOT NULL, fingerprint text NOT NULL,
 request_version integer NOT NULL CHECK(request_version>0), authorization_id uuid NOT NULL, authorization_version integer NOT NULL CHECK(authorization_version>0),
 snapshot jsonb NOT NULL, payload jsonb NOT NULL, evidence jsonb NOT NULL,
 status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','verified','rejected')),
 version integer NOT NULL DEFAULT 1 CHECK(version>0), reviewed_by uuid, reviewed_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(request_id,actor_id,request_key),
 FOREIGN KEY(org_id,company_id,order_id) REFERENCES work_orders(org_id,company_id,id),
 FOREIGN KEY(org_id,company_id,request_id) REFERENCES invoice_requests(org_id,company_id,id),
 FOREIGN KEY(org_id,company_id,authorization_id) REFERENCES invoice_authorizations(org_id,company_id,id),
 FOREIGN KEY(org_id,actor_id) REFERENCES users(org_id,id),
 FOREIGN KEY(org_id,reviewed_by) REFERENCES users(org_id,id),
 CHECK(status='pending' OR (reviewed_by IS NOT NULL AND reviewed_at IS NOT NULL AND reviewed_by<>actor_id))
);
CREATE UNIQUE INDEX invoice_result_pending ON invoice_result_records(request_id) WHERE status='pending';
CREATE UNIQUE INDEX invoice_result_issued ON invoice_result_records(request_id) WHERE status='verified' AND payload->>'outcome'='issued';
CREATE UNIQUE INDEX invoice_receipt_number ON invoice_result_records(org_id,(payload->>'sellerTaxId'),(payload->>'invoiceCode'),(payload->>'invoiceNumber'))
 WHERE status<>'rejected' AND payload->>'outcome'='issued';
CREATE INDEX invoice_result_request ON invoice_result_records(request_id,record_index DESC);
ALTER TABLE invoice_result_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE invoice_result_records FORCE ROW LEVEL SECURITY;
CREATE POLICY scope ON invoice_result_records USING(org_id=actor_org() AND can_company(company_id))
 WITH CHECK(org_id=actor_org() AND can_company(company_id) AND actor_role()<>'viewer');
GRANT SELECT,INSERT ON invoice_result_records TO zy_app;
GRANT USAGE ON SEQUENCE invoice_result_records_record_index_seq TO zy_app;
GRANT UPDATE(status,version,reviewed_by,reviewed_at) ON invoice_result_records TO zy_app;
INSERT INTO schema_migrations(version) VALUES(18);
