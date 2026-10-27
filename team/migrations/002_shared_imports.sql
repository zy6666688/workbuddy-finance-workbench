-- Company imports are collaborative; organization-wide previews remain personal.
DROP POLICY scope ON import_previews;
CREATE POLICY scope ON import_previews USING(
 org_id=actor_org() AND ((company_id IS NOT NULL AND can_company(company_id)) OR (company_id IS NULL AND actor_id=actor_id()))
) WITH CHECK(org_id=actor_org() AND actor_role()<>'viewer' AND ((company_id IS NOT NULL AND can_company(company_id)) OR (company_id IS NULL AND actor_id=actor_id())));
CREATE POLICY owner_jobs_read ON jobs FOR SELECT USING(org_id=actor_org() AND actor_role()='owner');
CREATE INDEX jobs_pending ON jobs(created_at) WHERE status='pending';
CREATE INDEX runs_order ON runs(order_id,revision,status);
INSERT INTO schema_migrations(version) VALUES(2);
