-- Match fixed-scope file pages and same-name latest-version lookups. The file
-- bodies stay in private storage; these indexes contain metadata only.
CREATE INDEX files_order_recent ON files(order_id,created_at DESC,id DESC);
CREATE INDEX files_order_latest ON files(order_id,kind,name,version DESC);
INSERT INTO schema_migrations(version) VALUES(11);
