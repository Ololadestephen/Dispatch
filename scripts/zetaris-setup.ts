/**
 * Seeds Dispatch's two backing systems and registers them in the local Zetaris platform.
 * Reads credentials from .env.local; prints no secrets. Run: npm run zetaris:setup
 */
import {
  BackingStores,
  backingStoreConfigFromEnv,
  ZETARIS_DATASOURCE,
  ZETARIS_FILES_DB
} from '../src/integrations/zetaris/backingStores';
import { ZetarisClient, zetarisConfigFromEnv } from '../src/integrations/zetaris/client';
import {
  DEMO_ORDER,
  DEMO_WAREHOUSE,
  DEMO_SUPPLIER_MESSAGE,
  DEMO_BACKUP_LISTING,
  DEMO_INBOUND_SHIPMENT
} from '../src/demo/seedData';

process.loadEnvFile('.env.local');
const storeConfig = backingStoreConfigFromEnv();
const zetarisConfig = zetarisConfigFromEnv();
if (!storeConfig || !zetarisConfig) {
  console.error('Missing DISPATCH_PG_* or ZETARIS_* settings in .env.local.');
  process.exit(1);
}

const stores = new BackingStores(storeConfig);
const client = new ZetarisClient(zetarisConfig);

await stores.seed({
  order: DEMO_ORDER,
  warehouse: DEMO_WAREHOUSE,
  supplierMessage: DEMO_SUPPLIER_MESSAGE,
  backupListing: DEMO_BACKUP_LISTING,
  inboundShipment: DEMO_INBOUND_SHIPMENT
});
console.log('Seeded PostgreSQL and files.');
await stores.registerInZetaris(client);
console.log(
  `Registered datasource ${ZETARIS_DATASOURCE} and Lightning database ${ZETARIS_FILES_DB}.`
);

for (const sql of [
  `SHOW DATASOURCE TABLES ${ZETARIS_DATASOURCE}`,
  `SHOW LIGHTNING TABLES ${ZETARIS_FILES_DB}`
]) {
  const r = await client.query(sql);
  console.log(`${sql}: ${JSON.stringify(r.rows).slice(0, 400)}`);
}
