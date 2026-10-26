# Bencho blocks (modified)

Source: https://github.com/cabralorenzo/bencho (free blocks, MIT), commit 91d66c9 (2026-10-22).
Copyright (c) 2026 Lorenzo Cabra. MIT licence text in `LICENSE`.

Modified for Dispatch:
- `SlideConfirm`: label/doneLabel/disabled/onConfirm props; keyboard confirm (Enter/Space on the handle);
  resets only when the action fails instead of on a demo timer.
- `StepPlayer`: driven by the real lookup steps (count, current step, onStep callback).
- `ToastStack`: shows only the toasts it is given; the demo pool and fake "retry" removed.
- `tokens.css`: values mapped to Dispatch's design tokens.
