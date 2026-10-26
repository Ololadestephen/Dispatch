-- Receipt versions are append-only: a correction is a new version, never an edit.
CREATE TRIGGER IF NOT EXISTS receipt_versions_immutable
BEFORE UPDATE ON receipt_versions
BEGIN
  SELECT RAISE(ABORT, 'receipt_versions rows are immutable');
END;

-- Audit events are append-only.
CREATE TRIGGER IF NOT EXISTS audit_events_immutable
BEFORE UPDATE ON audit_events
BEGIN
  SELECT RAISE(ABORT, 'audit_events rows are immutable');
END;

-- One approval per approved receipt version; one confirmation per receipt version.
CREATE UNIQUE INDEX IF NOT EXISTS approvals_one_per_version ON approvals (receipt_id, receipt_version);
CREATE UNIQUE INDEX IF NOT EXISTS confirmations_one_per_version ON supplier_confirmations (receipt_id, receipt_version);
