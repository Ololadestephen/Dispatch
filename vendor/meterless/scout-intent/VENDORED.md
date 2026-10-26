# Vendored: Meterless Scout Intent specification and eval harness

- Source: https://github.com/meterless/meterless/tree/main/engines/scout-intent
- Commit: 1742dec56a66e58eef9dda2d2b865823758ca8cd (2026-10-19)
- License: Apache-2.0 (see LICENSE). Copied unmodified: LICENSE, README.md, AGENTS.md, package.json, docs/, evals/.
- Not copied: images/, content/, workshops/, examples/, package-lock.json.

This folder is Meterless's specification and verification harness. It contains no runtime code.
Dispatch's implementation of the spec lives in `src/integrations/meterless/scout/` and is checked
against this harness with `npm run eval:scout`.
