import { DomainError } from '../../domain/errors';
import { BackingStores, backingStoreConfigFromEnv } from '../zetaris/backingStores';
import { ZetarisClient, zetarisConfigFromEnv } from '../zetaris/client';
import { ZetarisReader } from '../zetaris/reader';
import { SourceGateway } from './gateway';
import { LocalFileStore } from './localFiles';
import type { ActiveReservationReader } from '../../domain/reservation';

export { SourceGateway } from './gateway';
export { LocalFileStore } from './localFiles';

/**
 * DISPATCH_SOURCES selects where source records are read from:
 *  - "zetaris": every read is a Zetaris SQL query (requires ZETARIS_* and DISPATCH_PG_* settings).
 *  - "local" (default): Dispatch reads local files itself, and the UI says so.
 * A misconfigured Zetaris mode is an error at startup, never a silent switch to local files.
 */
export function createSourceGateway(
  dataDir: string,
  env: Record<string, string | undefined> = process.env,
  reservations?: ActiveReservationReader
): SourceGateway {
  const mode = env.DISPATCH_SOURCES ?? 'local';
  if (mode === 'local') {
    const store = new LocalFileStore(dataDir);
    return new SourceGateway(store, store, reservations);
  }
  if (mode !== 'zetaris') {
    throw new Error(`DISPATCH_SOURCES must be "zetaris" or "local", got "${mode}".`);
  }
  const zetaris = zetarisConfigFromEnv(env);
  const stores = backingStoreConfigFromEnv(env);
  if (!zetaris || !stores) {
    throw new DomainError(
      'DISPATCH_SOURCES=zetaris needs ZETARIS_BASE_URL, ZETARIS_USERNAME, ZETARIS_PASSWORD and DISPATCH_PG_PASSWORD.',
      'SOURCE_UNAVAILABLE'
    );
  }
  return new SourceGateway(
    new ZetarisReader(new ZetarisClient(zetaris)),
    new BackingStores(stores),
    reservations
  );
}
