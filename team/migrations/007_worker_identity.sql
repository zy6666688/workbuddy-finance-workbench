DROP FUNCTION worker_actor(uuid);
CREATE FUNCTION worker_actor(uid uuid) RETURNS TABLE(id uuid,org_id uuid,username text,name text,role text,must_change_password boolean,csrf text)
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT id,org_id,username,name,role,must_change_password,''::text FROM users WHERE id=uid AND active
$$;
REVOKE ALL ON FUNCTION worker_actor(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION worker_actor(uuid) TO zy_queue;
INSERT INTO schema_migrations(version) VALUES(7);
