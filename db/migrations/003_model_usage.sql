-- Usage is independent of demo receipts and survives demo reset. Reservations and
-- outcomes are append-only; a crashed process leaves a conservatively charged reservation.
CREATE TABLE model_usage_metadata (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  tracking_started_at_iso TEXT NOT NULL
);
INSERT INTO model_usage_metadata VALUES (1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));

CREATE TABLE model_call_reservations (
  attempt_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  order_id TEXT NOT NULL,
  actor_user_id TEXT NOT NULL,
  model TEXT NOT NULL,
  reserved_tokens INTEGER NOT NULL CHECK (reserved_tokens > 0),
  started_at_iso TEXT NOT NULL
);

CREATE TABLE model_call_outcomes (
  attempt_id TEXT PRIMARY KEY REFERENCES model_call_reservations(attempt_id),
  status TEXT NOT NULL CHECK (status IN ('succeeded', 'failed')),
  reported_tokens INTEGER CHECK (reported_tokens >= 0),
  error_code TEXT,
  finished_at_iso TEXT NOT NULL
);

CREATE TRIGGER model_reservations_no_update BEFORE UPDATE ON model_call_reservations
BEGIN SELECT RAISE(ABORT, 'model usage is immutable'); END;
CREATE TRIGGER model_reservations_no_delete BEFORE DELETE ON model_call_reservations
BEGIN SELECT RAISE(ABORT, 'model usage survives demo reset'); END;
CREATE TRIGGER model_outcomes_no_update BEFORE UPDATE ON model_call_outcomes
BEGIN SELECT RAISE(ABORT, 'model usage is immutable'); END;
CREATE TRIGGER model_outcomes_no_delete BEFORE DELETE ON model_call_outcomes
BEGIN SELECT RAISE(ABORT, 'model usage survives demo reset'); END;
