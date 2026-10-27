-- Shared backup-lot reservations (005_reservations.sql)
-- One approval reserves the shortfall it needs from a specific backup listing.
-- Allocation is first-come, first-served inside the approval transaction; an existing
-- reservation is released (never deleted) when its receipt becomes stale.

CREATE TABLE IF NOT EXISTS backup_reservations (
  reservation_id TEXT PRIMARY KEY,
  backup_listing_id TEXT NOT NULL,
  backup_revision_id TEXT NOT NULL,
  sku TEXT NOT NULL,
  order_id TEXT NOT NULL,
  receipt_id TEXT NOT NULL,
  receipt_version INTEGER NOT NULL,
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  status TEXT NOT NULL CHECK (status IN ('active', 'released')),
  idempotency_key TEXT NOT NULL,
  created_at_iso TEXT NOT NULL,
  released_at_iso TEXT,
  release_reason TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS one_active_reservation_per_plan
  ON backup_reservations (receipt_id, receipt_version)
  WHERE status = 'active';

CREATE INDEX IF NOT EXISTS active_reservations_by_lot
  ON backup_reservations (backup_listing_id, status);

-- Existing approvals predate shared lots. Backfill one active hold for each latest plan that is
-- already approved, so a new approval cannot silently take stock an approved plan already needs.
INSERT INTO backup_reservations (
  reservation_id, backup_listing_id, backup_revision_id, sku, order_id, receipt_id,
  receipt_version, quantity, status, idempotency_key, created_at_iso,
  released_at_iso, release_reason
)
SELECT
  'RSV-MIG-' || r.receipt_id || '-V' || r.version,
  json_extract(r.payload_json, '$.candidateRemedy.listingId'),
  json_extract(r.payload_json, '$.candidateRemedy.revisionId'),
  json_extract(r.payload_json, '$.calculations.sku'),
  r.order_id,
  r.receipt_id,
  r.version,
  json_extract(r.payload_json, '$.calculations.shortfall'),
  'active',
  'migration-005',
  r.created_at_iso,
  NULL,
  NULL
FROM receipt_versions r
JOIN (
  SELECT receipt_id, MAX(version) AS version
  FROM receipt_versions
  GROUP BY receipt_id
) latest ON latest.receipt_id = r.receipt_id AND latest.version = r.version
WHERE r.status IN ('approved', 'awaiting_confirmation', 'confirmed')
  AND json_extract(r.payload_json, '$.candidateRemedy.listingId') IS NOT NULL
  AND json_extract(r.payload_json, '$.calculations.shortfall') > 0
  AND NOT EXISTS (
    SELECT 1 FROM backup_reservations b
    WHERE b.receipt_id = r.receipt_id AND b.receipt_version = r.version
  );
