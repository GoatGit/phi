-- PHI migrations have a separate namespace from the frozen fork's user_version.
CREATE TABLE IF NOT EXISTS phi_schema_migrations(version INTEGER PRIMARY KEY,created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS route_decisions(
  request_id TEXT PRIMARY KEY,ts INTEGER NOT NULL,agent TEXT NOT NULL,project_id TEXT,
  state TEXT NOT NULL CHECK(state IN ('pending','completed','blocked','failed','interrupted')),
  payload TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ledger_time ON route_decisions(ts);
CREATE INDEX IF NOT EXISTS idx_ledger_agent_time ON route_decisions(agent,ts);
CREATE TABLE IF NOT EXISTS route_attempts(
  request_id TEXT NOT NULL REFERENCES route_decisions(request_id),attempt_no INTEGER NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('started','completed','failed','interrupted')),payload TEXT NOT NULL,
  PRIMARY KEY(request_id,attempt_no)
);
CREATE TABLE IF NOT EXISTS budgets(id TEXT PRIMARY KEY,payload TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS budget_usage(
  budget_id TEXT NOT NULL REFERENCES budgets(id),window_start INTEGER NOT NULL,window_end INTEGER NOT NULL,payload TEXT NOT NULL,
  PRIMARY KEY(budget_id,window_start)
);
CREATE TABLE IF NOT EXISTS budget_attempts(
  budget_id TEXT NOT NULL REFERENCES budgets(id),request_id TEXT NOT NULL,attempt_no INTEGER NOT NULL,
  window_start INTEGER NOT NULL,accounted_cost TEXT,accounted_tokens INTEGER,
  PRIMARY KEY(budget_id,request_id,attempt_no),
  FOREIGN KEY(request_id,attempt_no) REFERENCES route_attempts(request_id,attempt_no)
);
INSERT OR IGNORE INTO phi_schema_migrations(version,created_at)
VALUES(100,CAST((julianday('now')-2440587.5)*86400000 AS INTEGER));

CREATE TABLE IF NOT EXISTS billing_adjustments(id TEXT PRIMARY KEY,payload TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS ledger_metadata(key TEXT PRIMARY KEY,value INTEGER NOT NULL);

CREATE TABLE IF NOT EXISTS budget_alerts(budget_id TEXT NOT NULL REFERENCES budgets(id),window_start INTEGER NOT NULL,reason TEXT NOT NULL,created_at INTEGER NOT NULL,PRIMARY KEY(budget_id,window_start,reason));

-- Reporting only: budgets always retain the authenticated project at admission.
CREATE TABLE IF NOT EXISTS ledger_daily_dimensions(
  day INTEGER NOT NULL,agent TEXT NOT NULL,project_id TEXT NOT NULL,
  dimension TEXT NOT NULL,value TEXT NOT NULL,payload TEXT NOT NULL,
  PRIMARY KEY(day,agent,project_id,dimension,value)
);
CREATE TABLE IF NOT EXISTS ledger_request_rollups(
  request_id TEXT PRIMARY KEY REFERENCES route_decisions(request_id),payload TEXT NOT NULL
);
