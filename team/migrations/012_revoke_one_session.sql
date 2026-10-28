-- A workstation can revoke its own session without signing other devices out.
CREATE FUNCTION revoke_current_session(h text) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path=public,pg_temp AS $$
 DELETE FROM sessions WHERE token_hash=h AND user_id=actor_id()
$$;
REVOKE ALL ON FUNCTION revoke_current_session(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION revoke_current_session(text) TO zy_app;
