import path from 'node:path';

/**
 * Mutable test data lives under one root per process, so two overlapping Vitest runs can never
 * share a SQLite file, world-model store or CSV fixture. Within a run each test file gets its own
 * worker process, so file-scoped directories stay isolated too.
 */
export const RUN_ROOT = path.join(process.cwd(), 'tests/.tmp/runs', String(process.pid));

export function runTmp(...segments: string[]): string {
  return path.join(RUN_ROOT, ...segments);
}
