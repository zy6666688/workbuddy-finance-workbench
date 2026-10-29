ALTER TABLE runs DROP CONSTRAINT runs_execution_mode_check;
ALTER TABLE runs ADD CONSTRAINT runs_execution_mode_check CHECK(execution_mode IN ('workbuddy','embedded_accounting','embedded_rules'));
INSERT INTO schema_migrations(version) VALUES(17);
