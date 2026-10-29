-- Append-only confirmed versions; monthly bindings never change implicitly.
CREATE TABLE client_dossier_revisions (
 id uuid PRIMARY KEY, org_id uuid NOT NULL, company_id uuid NOT NULL,
 version integer NOT NULL CHECK(version>0), effective_from text NOT NULL CHECK(effective_from ~ '^20[0-9]{2}-(0[1-9]|1[0-2])$'),
 payload jsonb NOT NULL, reason text NOT NULL, actor_id uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(org_id,company_id) REFERENCES companies(org_id,id), FOREIGN KEY(org_id,actor_id) REFERENCES users(org_id,id),
 UNIQUE(company_id,version), UNIQUE(org_id,company_id,id)
);
CREATE INDEX dossier_effective ON client_dossier_revisions(company_id,effective_from DESC,version DESC);
CREATE TABLE client_dossier_drafts (
 id uuid PRIMARY KEY, org_id uuid NOT NULL, company_id uuid NOT NULL, base_version integer NOT NULL,
 company_version integer NOT NULL, effective_from text NOT NULL, payload jsonb NOT NULL, reason text NOT NULL,
 actor_id uuid NOT NULL, request_key uuid NOT NULL, fingerprint text NOT NULL,
 status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','confirmed','withdrawn')),
 revision_id uuid, created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(org_id,company_id) REFERENCES companies(org_id,id), FOREIGN KEY(org_id,actor_id) REFERENCES users(org_id,id),
 FOREIGN KEY(org_id,company_id,revision_id) REFERENCES client_dossier_revisions(org_id,company_id,id),
 UNIQUE(company_id,actor_id,request_key)
);
CREATE TABLE client_dossier_bindings (
 org_id uuid NOT NULL, company_id uuid NOT NULL, period text NOT NULL, revision_id uuid NOT NULL, actor_id uuid NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(company_id,period),
 FOREIGN KEY(company_id,period) REFERENCES work_orders(company_id,period),
 FOREIGN KEY(org_id,company_id,revision_id) REFERENCES client_dossier_revisions(org_id,company_id,id),
 FOREIGN KEY(org_id,actor_id) REFERENCES users(org_id,id)
);
CREATE TABLE client_dossier_documents (
 id uuid PRIMARY KEY, org_id uuid NOT NULL, company_id uuid NOT NULL, name text NOT NULL,
 storage_key text NOT NULL UNIQUE, size bigint NOT NULL, sha256 text NOT NULL, uploaded_by uuid NOT NULL,
 request_key uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(org_id,company_id) REFERENCES companies(org_id,id), FOREIGN KEY(org_id,uploaded_by) REFERENCES users(org_id,id),
 UNIQUE(company_id,uploaded_by,request_key)
);
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['client_dossier_revisions','client_dossier_drafts','client_dossier_bindings','client_dossier_documents'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('CREATE POLICY scope ON %I USING(org_id=actor_org() AND can_company(company_id)) WITH CHECK(org_id=actor_org() AND can_company(company_id) AND actor_role()<>''viewer'')',t);
  EXECUTE format('GRANT SELECT,INSERT ON %I TO zy_app',t);
 END LOOP;
END $$;
GRANT UPDATE(status,revision_id) ON client_dossier_drafts TO zy_app;
GRANT UPDATE(revision_id,actor_id,created_at) ON client_dossier_bindings TO zy_app;
INSERT INTO schema_migrations(version) VALUES(14);
