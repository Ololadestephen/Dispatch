-- Preserve existing approvals while admitting both roles supported by the domain policy.
-- RecoveryService still enforces the receipt's spend threshold before inserting a row.
ALTER TABLE approvals RENAME TO approvals_manager_only;

CREATE TABLE approvals (
  approval_id TEXT PRIMARY KEY,
  receipt_id TEXT NOT NULL,
  receipt_version INTEGER NOT NULL,
  approved_by_user_id TEXT NOT NULL,
  approved_by_name TEXT NOT NULL,
  approved_by_role TEXT NOT NULL CHECK (approved_by_role IN ('manager', 'operator')),
  idempotency_key TEXT NOT NULL,
  approved_at_iso TEXT NOT NULL
);

INSERT INTO approvals SELECT * FROM approvals_manager_only;
DROP TABLE approvals_manager_only;
CREATE UNIQUE INDEX approvals_one_per_version ON approvals (receipt_id, receipt_version);
