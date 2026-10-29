ALTER TABLE runs ADD COLUMN task_brief jsonb NOT NULL DEFAULT '{}';
INSERT INTO schema_migrations(version) VALUES(6);
