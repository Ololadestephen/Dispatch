-- Dispatch Application Database Schema (001_initial_schema.sql)
-- Stores versioned Decision Receipts (append-only, never overwritten),
-- approvals, internal tasks, supplier request drafts, supplier confirmations,
-- scoped idempotency keys, per-browser user sessions, and atomic audit events.

CREATE TABLE IF NOT EXISTS user_sessions (
  session_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  user_name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('manager', 'operator')),
  updated_at_iso TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS receipt_versions (
  receipt_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  order_id TEXT NOT NULL,
  status TEXT NOT NULL,
  execution_mode TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at_iso TEXT NOT NULL,
  PRIMARY KEY (receipt_id, version)
);

CREATE TABLE IF NOT EXISTS approvals (
  approval_id TEXT PRIMARY KEY,
  receipt_id TEXT NOT NULL,
  receipt_version INTEGER NOT NULL,
  approved_by_user_id TEXT NOT NULL,
  approved_by_name TEXT NOT NULL,
  approved_by_role TEXT NOT NULL CHECK (approved_by_role = 'manager'),
  idempotency_key TEXT NOT NULL,
  approved_at_iso TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS recovery_tasks (
  task_id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL,
  receipt_id TEXT NOT NULL,
  receipt_version INTEGER NOT NULL,
  title TEXT NOT NULL,
  assigned_role TEXT NOT NULL CHECK (assigned_role IN ('warehouse', 'procurement', 'dispatch')),
  status TEXT NOT NULL CHECK (status IN ('pending', 'completed')),
  created_at_iso TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS supplier_request_drafts (
  draft_id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL,
  receipt_id TEXT NOT NULL,
  receipt_version INTEGER NOT NULL,
  supplier_name TEXT NOT NULL,
  sku TEXT NOT NULL,
  requested_quantity INTEGER NOT NULL,
  offered_cost_kobo INTEGER NOT NULL,
  required_delivery_by_iso TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('draft_prepared', 'ready_for_operator_review')),
  is_sent INTEGER NOT NULL CHECK (is_sent = 0),
  body_text TEXT NOT NULL,
  created_at_iso TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS supplier_confirmations (
  confirmation_id TEXT PRIMARY KEY,
  receipt_id TEXT NOT NULL,
  receipt_version INTEGER NOT NULL,
  supplier_name TEXT NOT NULL,
  sku TEXT NOT NULL,
  confirmed_quantity INTEGER NOT NULL,
  confirmed_arrival_iso TEXT NOT NULL,
  confirmation_reference TEXT NOT NULL,
  evidence_excerpt TEXT NOT NULL,
  is_simulated INTEGER NOT NULL CHECK (is_simulated IN (0, 1)),
  recorded_by_user_id TEXT NOT NULL,
  recorded_by_name TEXT NOT NULL,
  recorded_by_role TEXT NOT NULL CHECK (recorded_by_role IN ('manager', 'operator')),
  recorded_at_iso TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS idempotency_records (
  scoped_key TEXT PRIMARY KEY,
  receipt_id TEXT NOT NULL,
  receipt_version INTEGER NOT NULL,
  actor_user_id TEXT NOT NULL,
  response_json TEXT NOT NULL,
  created_at_iso TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_events (
  event_id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL,
  receipt_id TEXT,
  receipt_version INTEGER,
  event_type TEXT NOT NULL,
  actor_user_id TEXT NOT NULL,
  actor_name TEXT NOT NULL,
  actor_role TEXT NOT NULL,
  scenario_time_iso TEXT NOT NULL,
  wall_clock_iso TEXT NOT NULL,
  summary TEXT NOT NULL,
  details_json TEXT NOT NULL
);
