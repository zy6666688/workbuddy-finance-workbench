-- pg-boss owns only its queue schema; business tables remain owned by postgres.
DO $$ BEGIN EXECUTE format('GRANT CREATE ON DATABASE %I TO zy_queue',current_database()); END $$;
INSERT INTO schema_migrations(version) VALUES(3);
