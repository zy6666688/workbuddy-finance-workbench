-- Append-only continuation history and accounting preparation, never posting.
ALTER TABLE invoice_batch_items ADD UNIQUE(org_id,company_id,id);
ALTER TABLE invoice_result_records ADD UNIQUE(org_id,company_id,id);
ALTER TABLE accounting_snapshots ADD UNIQUE(org_id,company_id,id);

CREATE TABLE invoice_continuations (
 id uuid PRIMARY KEY, org_id uuid NOT NULL, batch_id uuid NOT NULL, actor_id uuid NOT NULL,
 request_key uuid NOT NULL, fingerprint text NOT NULL, item_count integer NOT NULL CHECK(item_count BETWEEN 1 AND 50),
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(org_id,id), UNIQUE(batch_id,actor_id,request_key),
 FOREIGN KEY(org_id,batch_id) REFERENCES invoice_batches(org_id,id), FOREIGN KEY(org_id,actor_id) REFERENCES users(org_id,id)
);
ALTER TABLE invoice_continuations ENABLE ROW LEVEL SECURITY;
ALTER TABLE invoice_continuations FORCE ROW LEVEL SECURITY;
CREATE POLICY scope ON invoice_continuations USING(org_id=actor_org() AND EXISTS(SELECT 1 FROM invoice_batches b WHERE b.id=batch_id))
 WITH CHECK(org_id=actor_org() AND actor_id=actor_id() AND actor_role()<>'viewer' AND EXISTS(SELECT 1 FROM invoice_batches b WHERE b.id=batch_id));
GRANT SELECT,INSERT ON invoice_continuations TO zy_app;

CREATE TABLE invoice_ledger (
 id uuid PRIMARY KEY, org_id uuid NOT NULL, company_id uuid NOT NULL, order_id uuid NOT NULL,
 request_id uuid NOT NULL, result_id uuid NOT NULL UNIQUE, actor_id uuid NOT NULL,
 snapshot jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(org_id,company_id,id),
 FOREIGN KEY(org_id,company_id,order_id) REFERENCES work_orders(org_id,company_id,id),
 FOREIGN KEY(org_id,company_id,request_id) REFERENCES invoice_requests(org_id,company_id,id),
 FOREIGN KEY(org_id,company_id,result_id) REFERENCES invoice_result_records(org_id,company_id,id),
 FOREIGN KEY(org_id,actor_id) REFERENCES users(org_id,id)
);
CREATE TABLE invoice_accounting_rules (
 id uuid PRIMARY KEY, org_id uuid NOT NULL, company_id uuid NOT NULL, business_type text NOT NULL,
 version integer NOT NULL CHECK(version>0), actor_id uuid NOT NULL, request_key uuid NOT NULL, fingerprint text NOT NULL,
 basis_period text NOT NULL, basis_snapshot_id uuid, payload jsonb NOT NULL, reason text NOT NULL,
 status text NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','verified','rejected','superseded')),
 reviewed_by uuid, reviewed_at timestamptz, review_reason text,
 created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(org_id,company_id,id),
 UNIQUE(company_id,business_type,version), UNIQUE(company_id,actor_id,request_key),
 FOREIGN KEY(org_id,company_id) REFERENCES companies(org_id,id),
 FOREIGN KEY(org_id,company_id,basis_snapshot_id) REFERENCES accounting_snapshots(org_id,company_id,id),
 FOREIGN KEY(org_id,actor_id) REFERENCES users(org_id,id), FOREIGN KEY(org_id,reviewed_by) REFERENCES users(org_id,id),
 CHECK(status<>'verified' OR (reviewed_by IS NOT NULL AND reviewed_at IS NOT NULL AND reviewed_by<>actor_id))
);
CREATE UNIQUE INDEX invoice_rule_active ON invoice_accounting_rules(company_id,business_type) WHERE status='verified';

CREATE TABLE invoice_accounting_drafts (
 id uuid PRIMARY KEY, org_id uuid NOT NULL, company_id uuid NOT NULL, order_id uuid NOT NULL,
 ledger_id uuid NOT NULL, version integer NOT NULL CHECK(version>0), period text NOT NULL,
 actor_id uuid NOT NULL, request_key uuid NOT NULL, fingerprint text NOT NULL,
 context jsonb NOT NULL, basis jsonb NOT NULL, basis_fingerprint text NOT NULL,
 lines jsonb NOT NULL, issues jsonb NOT NULL, claimed_voucher text,
 status text NOT NULL CHECK(status IN ('blocked','pending','verified','rejected','superseded')),
 reviewed_by uuid, reviewed_at timestamptz, review_reason text, created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(org_id,company_id,id), UNIQUE(ledger_id,version), UNIQUE(ledger_id,actor_id,request_key),
 FOREIGN KEY(org_id,company_id,order_id) REFERENCES work_orders(org_id,company_id,id),
 FOREIGN KEY(org_id,company_id,ledger_id) REFERENCES invoice_ledger(org_id,company_id,id),
 FOREIGN KEY(org_id,actor_id) REFERENCES users(org_id,id), FOREIGN KEY(org_id,reviewed_by) REFERENCES users(org_id,id),
 CHECK(status<>'verified' OR (reviewed_by IS NOT NULL AND reviewed_at IS NOT NULL AND reviewed_by<>actor_id))
);
CREATE UNIQUE INDEX invoice_accounting_verified ON invoice_accounting_drafts(ledger_id) WHERE status='verified';
CREATE UNIQUE INDEX invoice_accounting_voucher_claim ON invoice_accounting_drafts(company_id,period,claimed_voucher) WHERE claimed_voucher IS NOT NULL AND status IN ('pending','verified');

CREATE TABLE invoice_continuation_items (
 attempt_index bigint GENERATED ALWAYS AS IDENTITY,
 id uuid PRIMARY KEY, org_id uuid NOT NULL, company_id uuid NOT NULL, continuation_id uuid NOT NULL,
 item_id uuid NOT NULL, action text NOT NULL CHECK(action IN ('repair','retry','ledger','accounting')),
 status text NOT NULL CHECK(status IN ('completed','blocked')), request_id uuid, ledger_id uuid, draft_id uuid,
 payload jsonb NOT NULL, error text, created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(continuation_id,item_id),
 FOREIGN KEY(org_id,continuation_id) REFERENCES invoice_continuations(org_id,id),
 FOREIGN KEY(org_id,company_id,item_id) REFERENCES invoice_batch_items(org_id,company_id,id),
 FOREIGN KEY(org_id,company_id,request_id) REFERENCES invoice_requests(org_id,company_id,id),
 FOREIGN KEY(org_id,company_id,ledger_id) REFERENCES invoice_ledger(org_id,company_id,id),
 FOREIGN KEY(org_id,company_id,draft_id) REFERENCES invoice_accounting_drafts(org_id,company_id,id)
);
CREATE INDEX invoice_attempt_latest ON invoice_continuation_items(item_id,attempt_index DESC);
CREATE INDEX invoice_ledger_order ON invoice_ledger(order_id,created_at DESC);
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['invoice_ledger','invoice_accounting_rules','invoice_accounting_drafts','invoice_continuation_items'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('CREATE POLICY scope ON %I USING(org_id=actor_org() AND can_company(company_id)) WITH CHECK(org_id=actor_org() AND can_company(company_id) AND actor_role()<>''viewer'')',t);
  EXECUTE format('GRANT SELECT,INSERT ON %I TO zy_app',t);
 END LOOP;
END $$;
GRANT UPDATE(status,reviewed_by,reviewed_at,review_reason) ON invoice_accounting_rules,invoice_accounting_drafts TO zy_app;
GRANT USAGE ON SEQUENCE invoice_continuation_items_attempt_index_seq TO zy_app;
INSERT INTO schema_migrations(version) VALUES(19);
