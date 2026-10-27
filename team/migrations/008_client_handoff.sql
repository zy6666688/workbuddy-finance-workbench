-- Additive: existing clients keep their templates, access and monthly history.
ALTER TABLE companies ADD COLUMN profile jsonb NOT NULL DEFAULT '{}';
ALTER TABLE companies ADD COLUMN default_assignee_id uuid;
ALTER TABLE companies ADD COLUMN default_reviewer_id uuid;
ALTER TABLE companies ADD CONSTRAINT company_assignee_org FOREIGN KEY(org_id,default_assignee_id) REFERENCES users(org_id,id);
ALTER TABLE companies ADD CONSTRAINT company_reviewer_org FOREIGN KEY(org_id,default_reviewer_id) REFERENCES users(org_id,id);
ALTER TABLE companies ADD CONSTRAINT company_separate_roles CHECK(default_assignee_id IS NULL OR default_reviewer_id IS NULL OR default_assignee_id<>default_reviewer_id);
CREATE INDEX reviews_order_latest ON reviews(order_id,created_at DESC,id);
INSERT INTO schema_migrations(version) VALUES(8);
