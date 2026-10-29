CREATE TABLE IF NOT EXISTS schema_migrations(version integer PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE organizations(id uuid PRIMARY KEY, name text NOT NULL);
CREATE TABLE users(
 id uuid PRIMARY KEY, org_id uuid NOT NULL REFERENCES organizations, username text NOT NULL UNIQUE,
 name text NOT NULL, password_hash text NOT NULL, role text NOT NULL CHECK(role IN ('owner','reviewer','operator','viewer')),
 active boolean NOT NULL DEFAULT true, must_change_password boolean NOT NULL DEFAULT true,
 version integer NOT NULL DEFAULT 1, created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(org_id,id)
);
CREATE TABLE sessions(token_hash text PRIMARY KEY, user_id uuid NOT NULL REFERENCES users, csrf text NOT NULL, expires_at timestamptz NOT NULL);
CREATE INDEX sessions_user ON sessions(user_id);
CREATE TABLE companies(
 id uuid PRIMARY KEY, org_id uuid NOT NULL REFERENCES organizations, code text NOT NULL, name text NOT NULL,
 active boolean NOT NULL DEFAULT true, version integer NOT NULL DEFAULT 1,
 template jsonb NOT NULL DEFAULT '[{"name":"银行流水","required":true},{"name":"账务明细","required":true},{"name":"票据资料","required":true}]',
 created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(org_id,code), UNIQUE(org_id,id)
);
CREATE TABLE memberships(org_id uuid NOT NULL, company_id uuid NOT NULL, user_id uuid NOT NULL,
 PRIMARY KEY(company_id,user_id), FOREIGN KEY(org_id,company_id) REFERENCES companies(org_id,id), FOREIGN KEY(org_id,user_id) REFERENCES users(org_id,id));
CREATE INDEX memberships_user ON memberships(user_id,company_id);
CREATE TABLE work_orders(
 id uuid PRIMARY KEY, org_id uuid NOT NULL, company_id uuid NOT NULL, period text NOT NULL CHECK(period ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
 status text NOT NULL DEFAULT 'collecting' CHECK(status IN ('collecting','checking','processing','review','delivery','archived')),
 assignee_id uuid, reviewer_id uuid, due_date date NOT NULL, checklist jsonb NOT NULL,
 version integer NOT NULL DEFAULT 1, revision integer NOT NULL DEFAULT 1,
 contributors uuid[] NOT NULL DEFAULT '{}', submission jsonb, reopen_request jsonb,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(org_id,company_id) REFERENCES companies(org_id,id), FOREIGN KEY(org_id,assignee_id) REFERENCES users(org_id,id),
 FOREIGN KEY(org_id,reviewer_id) REFERENCES users(org_id,id), UNIQUE(company_id,period), UNIQUE(org_id,company_id,id)
);
CREATE INDEX work_orders_list ON work_orders(company_id,period DESC,status);
CREATE INDEX work_orders_due ON work_orders(org_id,status,due_date);
CREATE TABLE files(
 id uuid PRIMARY KEY, org_id uuid NOT NULL, company_id uuid NOT NULL, order_id uuid NOT NULL,
 name text NOT NULL, kind text NOT NULL CHECK(kind IN ('source','result','evidence')), category text NOT NULL,
 size bigint NOT NULL CHECK(size >= 0), sha256 text NOT NULL, storage_key text NOT NULL UNIQUE,
 uploaded_by uuid NOT NULL REFERENCES users, version integer NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(org_id,company_id,order_id) REFERENCES work_orders(org_id,company_id,id)
);
CREATE INDEX files_order ON files(order_id,kind,created_at DESC);
CREATE TABLE runs(
 id uuid PRIMARY KEY, org_id uuid NOT NULL, company_id uuid NOT NULL, order_id uuid NOT NULL,
 workflow_id text NOT NULL, status text NOT NULL DEFAULT 'external' CHECK(status IN ('external','returned','stale')),
 input_files jsonb NOT NULL, result_files uuid[] NOT NULL DEFAULT '{}', check_result jsonb,
 revision integer NOT NULL, created_by uuid NOT NULL REFERENCES users, version integer NOT NULL DEFAULT 1,
 created_at timestamptz NOT NULL DEFAULT now(), FOREIGN KEY(org_id,company_id,order_id) REFERENCES work_orders(org_id,company_id,id)
);
CREATE TABLE reviews(
 id uuid PRIMARY KEY, org_id uuid NOT NULL, company_id uuid NOT NULL, order_id uuid NOT NULL,
 revision integer NOT NULL, actor_id uuid NOT NULL REFERENCES users, action text NOT NULL, reason text NOT NULL, snapshot jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), FOREIGN KEY(org_id,company_id,order_id) REFERENCES work_orders(org_id,company_id,id)
);
CREATE TABLE audit_events(
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, org_id uuid NOT NULL REFERENCES organizations, company_id uuid,
 actor_id uuid NOT NULL REFERENCES users, action text NOT NULL, target_id text NOT NULL, details jsonb NOT NULL,
 request_id text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), FOREIGN KEY(org_id,company_id) REFERENCES companies(org_id,id)
);
CREATE INDEX audit_company ON audit_events(company_id,created_at DESC);
CREATE TABLE import_previews(
 id uuid PRIMARY KEY, org_id uuid NOT NULL REFERENCES organizations, company_id uuid, actor_id uuid NOT NULL REFERENCES users,
 kind text NOT NULL, digest text NOT NULL, payload jsonb NOT NULL, errors jsonb NOT NULL, committed_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(), FOREIGN KEY(org_id,company_id) REFERENCES companies(org_id,id)
);
CREATE UNIQUE INDEX import_dedup ON import_previews(org_id,coalesce(company_id,'00000000-0000-0000-0000-000000000000'::uuid),kind,digest);
CREATE TABLE jobs(
 id uuid PRIMARY KEY, org_id uuid NOT NULL REFERENCES organizations, company_id uuid, actor_id uuid NOT NULL REFERENCES users,
 kind text NOT NULL, status text NOT NULL DEFAULT 'pending', idempotency_key text NOT NULL, payload jsonb NOT NULL,
 result jsonb, error text, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(actor_id,kind,idempotency_key), FOREIGN KEY(org_id,company_id) REFERENCES companies(org_id,id)
);
CREATE TABLE legacy_imports(id uuid PRIMARY KEY, org_id uuid NOT NULL, company_id uuid NOT NULL,
 actor_id uuid NOT NULL REFERENCES users, payload jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(org_id,company_id) REFERENCES companies(org_id,id));
CREATE TABLE user_preferences(user_id uuid PRIMARY KEY REFERENCES users, value jsonb NOT NULL DEFAULT '{}');

CREATE FUNCTION actor_id() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('zy.actor',true),'')::uuid $$;
CREATE FUNCTION actor_org() RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$ SELECT org_id FROM users WHERE id=actor_id() AND active $$;
CREATE FUNCTION actor_role() RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$ SELECT role FROM users WHERE id=actor_id() AND active $$;
CREATE FUNCTION can_company(cid uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM companies c JOIN users u ON u.org_id=c.org_id WHERE u.id=actor_id() AND u.active AND c.id=cid AND
 (u.role='owner' OR EXISTS(SELECT 1 FROM memberships m WHERE m.user_id=u.id AND m.company_id=c.id)))
$$;
CREATE FUNCTION login_user(login text) RETURNS SETOF users LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$ SELECT * FROM users WHERE username=login AND active $$;
CREATE FUNCTION lookup_session(h text) RETURNS TABLE(id uuid,org_id uuid,username text,name text,role text,must_change_password boolean,csrf text)
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT u.id,u.org_id,u.username,u.name,u.role,u.must_change_password,s.csrf FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=h AND s.expires_at>now() AND u.active $$;
CREATE FUNCTION create_session(h text,uid uuid,c text) RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path=public,pg_temp AS $$
 INSERT INTO sessions(token_hash,user_id,csrf,expires_at) VALUES(h,uid,c,now()+interval '12 hours') $$;
CREATE FUNCTION revoke_sessions(uid uuid) RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path=public,pg_temp AS $$
 DELETE FROM sessions WHERE user_id=uid AND (uid=actor_id() OR (actor_role()='owner' AND EXISTS(SELECT 1 FROM users WHERE id=uid AND org_id=actor_org()))) $$;
REVOKE ALL ON FUNCTION actor_org(),actor_role(),can_company(uuid),login_user(text),lookup_session(text),create_session(text,uuid,text),revoke_sessions(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION actor_org(),actor_role(),can_company(uuid),login_user(text),lookup_session(text),create_session(text,uuid,text),revoke_sessions(uuid) TO zy_app;

ALTER TABLE users ENABLE ROW LEVEL SECURITY;
CREATE POLICY users_read ON users FOR SELECT USING(org_id=actor_org());
CREATE POLICY users_insert ON users FOR INSERT WITH CHECK(org_id=actor_org() AND actor_role()='owner');
CREATE POLICY users_update ON users FOR UPDATE USING(org_id=actor_org() AND (id=actor_id() OR actor_role()='owner')) WITH CHECK(org_id=actor_org());
ALTER TABLE companies ENABLE ROW LEVEL SECURITY;
CREATE POLICY company_read ON companies FOR SELECT USING(can_company(id));
CREATE POLICY company_insert ON companies FOR INSERT WITH CHECK(org_id=actor_org() AND actor_role()='owner');
CREATE POLICY company_update ON companies FOR UPDATE USING(can_company(id) AND actor_role() IN ('owner','reviewer')) WITH CHECK(org_id=actor_org());
ALTER TABLE memberships ENABLE ROW LEVEL SECURITY;
CREATE POLICY membership_read ON memberships FOR SELECT USING(org_id=actor_org() AND (user_id=actor_id() OR actor_role()='owner' OR can_company(company_id)));
CREATE POLICY membership_write ON memberships FOR ALL USING(org_id=actor_org() AND actor_role()='owner') WITH CHECK(org_id=actor_org() AND actor_role()='owner');
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['work_orders','files','runs','reviews','legacy_imports'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('CREATE POLICY scope ON %I USING(org_id=actor_org() AND can_company(company_id)) WITH CHECK(org_id=actor_org() AND can_company(company_id) AND actor_role()<>''viewer'')',t);
 END LOOP;
END $$;
ALTER TABLE audit_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY audit_read ON audit_events FOR SELECT USING(org_id=actor_org() AND (can_company(company_id) OR (company_id IS NULL AND actor_role()='owner')));
CREATE POLICY audit_insert ON audit_events FOR INSERT WITH CHECK(org_id=actor_org() AND actor_id=actor_id() AND (company_id IS NULL OR can_company(company_id)));
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['import_previews','jobs'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('CREATE POLICY scope ON %I USING(org_id=actor_org() AND actor_id=actor_id() AND (company_id IS NULL OR can_company(company_id))) WITH CHECK(org_id=actor_org() AND actor_id=actor_id() AND (company_id IS NULL OR can_company(company_id)))',t);
 END LOOP;
END $$;
ALTER TABLE user_preferences ENABLE ROW LEVEL SECURITY;
CREATE POLICY personal ON user_preferences USING(user_id=actor_id()) WITH CHECK(user_id=actor_id());
GRANT USAGE ON SCHEMA public TO zy_app;
GRANT SELECT,INSERT,UPDATE,DELETE ON users,companies,memberships,work_orders,files,runs,reviews,audit_events,import_previews,jobs,legacy_imports,user_preferences TO zy_app;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO zy_app;
REVOKE UPDATE,DELETE ON audit_events,reviews,files,legacy_imports FROM zy_app;
REVOKE DELETE ON users,companies,work_orders,runs FROM zy_app;
INSERT INTO schema_migrations(version) VALUES(1);
CREATE FUNCTION pending_jobs() RETURNS TABLE(id uuid,actor_id uuid) LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$ SELECT id,actor_id FROM jobs WHERE status='pending' ORDER BY created_at LIMIT 100 $$;
CREATE FUNCTION worker_actor(uid uuid) RETURNS SETOF users LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$ SELECT * FROM users WHERE id=uid AND active $$;
CREATE FUNCTION fail_job(jid uuid,message text) RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path=public,pg_temp AS $$ UPDATE jobs SET status='failed',error=left(message,300),updated_at=now() WHERE id=jid AND status<>'completed' $$;
REVOKE ALL ON FUNCTION pending_jobs(),worker_actor(uuid),fail_job(uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION pending_jobs(),worker_actor(uuid),fail_job(uuid,text) TO zy_queue;
