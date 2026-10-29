CREATE FUNCTION visible_company_ids() RETURNS SETOF uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT c.id FROM companies c JOIN users u ON u.org_id=c.org_id
 WHERE u.id=actor_id() AND u.active AND (u.role='owner' OR EXISTS(SELECT 1 FROM memberships m WHERE m.user_id=u.id AND m.company_id=c.id))
$$;
REVOKE ALL ON FUNCTION visible_company_ids() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION visible_company_ids() TO zy_app;
DROP POLICY company_read ON companies;
CREATE POLICY company_read ON companies FOR SELECT USING(id IN (SELECT visible_company_ids()));
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['work_orders','files','runs','reviews','legacy_imports'] LOOP
  EXECUTE format('DROP POLICY scope ON %I',t);
  EXECUTE format('CREATE POLICY scope ON %I USING(org_id=(SELECT actor_org()) AND company_id IN (SELECT visible_company_ids())) WITH CHECK(org_id=(SELECT actor_org()) AND company_id IN (SELECT visible_company_ids()) AND (SELECT actor_role())<>''viewer'')',t);
 END LOOP;
END $$;
CREATE INDEX files_company ON files(company_id);
CREATE INDEX orders_org_period_due ON work_orders(org_id,period,due_date,id);
INSERT INTO schema_migrations(version) VALUES(4);
