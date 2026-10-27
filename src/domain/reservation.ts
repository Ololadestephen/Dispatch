/**
 * Shared backup-lot allocation.
 *
 * A reservation belongs to one approved receipt version. The approval transaction reads active
 * reservations before inserting, so the first approval commits and every later request is judged
 * against what is left. Delivery deadlines do not pre-empt a reservation: they are only a hint
 * for the desk. This keeps the store's truth simple — committed stock is committed stock.
 */

export interface ActiveReservation {
  reservationId: string;
  backupListingId: string;
  backupRevisionId: string;
  sku: string;
  orderId: string;
  receiptId: string;
  receiptVersion: number;
  quantity: number;
  createdAtIso: string;
}

export interface BackupReservationRecord extends ActiveReservation {
  status: 'active' | 'released';
  idempotencyKey: string;
  releasedAtIso?: string;
  releaseReason?: string;
}

/** Advertised stock minus active reservations, with the orders that hold them. */
export interface BackupAvailability {
  listingId: string;
  advertisedQuantity: number;
  reservedQuantity: number;
  availableQuantity: number;
  reservations: ActiveReservation[];
}

/** Read-only view used by the source gateway; the persistence layer provides the concrete store. */
export interface ActiveReservationReader {
  listActiveReservations(backupListingId: string): ActiveReservation[];
}
