import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StateStore } from '../../src/server/stateStore';
import { createSourceGateway } from '../../src/integrations/sources';
import { NvidiaExtractionAgent } from '../../src/integrations/nvidia/extractionAgent';
import { DomainError } from '../../src/domain/errors';

describe('Source initialization', () => {
  let dir: string;
  let store: StateStore;

  beforeEach(() => {
    fs.mkdirSync('tests/.tmp', { recursive: true });
    dir = fs.mkdtempSync(path.join('tests/.tmp', 'store-init-'));
    store = new StateStore({
      dataDir: dir,
      evidenceDir: null,
      sources: createSourceGateway(dir, { DISPATCH_SOURCES: 'local' }),
      extractionAgent: NvidiaExtractionAgent.createWithMock()
    });
  });
  afterEach(() => {
    store.appDb.db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('shares one seed operation between concurrent first requests', async () => {
    const check = vi.spyOn(store.sources, 'isSeeded');
    const seed = vi.spyOn(store.sources, 'seed');
    await Promise.all([
      store.ensureInitialized(),
      store.ensureInitialized(),
      store.ensureInitialized()
    ]);
    expect(check).toHaveBeenCalledTimes(1);
    expect(seed).toHaveBeenCalledTimes(1);
    await store.ensureInitialized();
    expect(seed).toHaveBeenCalledTimes(1);
  });

  it('allows a later request to retry initialization after a source outage', async () => {
    const check = vi
      .spyOn(store.sources, 'isSeeded')
      .mockRejectedValueOnce(new DomainError('Source offline', 'SOURCE_UNAVAILABLE'));
    await expect(store.ensureInitialized()).rejects.toMatchObject({ code: 'SOURCE_UNAVAILABLE' });
    await store.ensureInitialized();
    expect(check).toHaveBeenCalledTimes(2);
    expect(await store.sources.isSeeded()).toBe(true);
  });
});
