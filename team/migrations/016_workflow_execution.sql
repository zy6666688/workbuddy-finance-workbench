ALTER TABLE runs ADD COLUMN execution_mode text NOT NULL DEFAULT 'workbuddy' CHECK(execution_mode IN ('workbuddy','embedded_accounting'));
UPDATE runs r SET execution_mode='embedded_accounting' WHERE EXISTS(SELECT 1 FROM jobs j WHERE j.kind='embedded_accounting' AND j.actor_id=r.created_by AND j.idempotency_key='workflow-task:'||r.id::text);
INSERT INTO schema_migrations(version) VALUES(16);
