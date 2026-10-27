import fs from 'node:fs';
import path from 'node:path';

const RUNS_DIR = path.join(process.cwd(), 'tests/.tmp/runs');

/** Removes run roots whose process is gone, so repeated runs do not accumulate fixtures. */
function pruneFinishedRuns(): void {
  if (!fs.existsSync(RUNS_DIR)) return;
  for (const entry of fs.readdirSync(RUNS_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const pid = Number(entry.name);
    if (!Number.isInteger(pid) || pid === process.pid) continue;
    try {
      process.kill(pid, 0);
    } catch {
      fs.rmSync(path.join(RUNS_DIR, entry.name), { recursive: true, force: true });
    }
  }
}

export function setup(): void {
  pruneFinishedRuns();
}

export function teardown(): void {
  pruneFinishedRuns();
}
