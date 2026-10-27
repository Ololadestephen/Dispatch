# Vendored: Meterless World Model reference implementation

- Source: https://github.com/meterless/meterless/tree/main/engines/world-model
- Commit: 1742dec56a66e58eef9dda2d2b865823758ca8cd (2026-10-19)
- License: Apache-2.0 (see LICENSE). Copied unmodified from the upstream commit.
- Copied: `LICENSE`, `README.md`, `AGENTS.md`, `reference/` (README, package.json, tsconfig, `src/`, `test/`), `conformance/` (README, runner), and `examples/scout-context-plan-to-world-query/`.
- Not copied: images, content, workshops, control plane, the browser bundle scripts, and `reference/package-lock.json`. No upstream file was edited.
- Runtime dependencies: none. The reference `package.json` lists `tsx`, `vitest` and `esbuild` as dev dependencies only; Dispatch does not install them and runs the vendored code with the repository's existing toolchain.

This folder is Meterless's reference implementation of its World Model contract. Dispatch's adapter
lives in `src/integrations/meterless/worldModel.ts`; it ingests records that Dispatch has already
read, answers the Scout context query from the mirror, and exposes the merge review queue. It does
not fetch sources, decide stock, reserve stock, or approve anything.

## Verification at this pin

- World Model conformance runner: `node --import tsx vendor/meterless/world-model/conformance/runner.ts` — 8/8 checks passed against the vendored reference.
- Reference smoke tests: 1 file / 10 tests passed, run with the repository's Vitest and a temporary include config; no dependency was added.

These results establish the vendored reference's own checks only. They do not establish conformance of
Dispatch's adapter or of the product.
