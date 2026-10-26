import { type CSSProperties, useRef, useState } from 'react';
import { motion } from 'framer-motion';
import { CircleCheck, CircleX, Info, TriangleAlert, X, type LucideIcon } from 'lucide-react';

/* Show up to three application notifications. Hovering the full expanded
   frame keeps the stack open while the individual toasts move beneath the pointer. */

export type ToastKind = 'success' | 'info' | 'error' | 'warning';
type Kind = ToastKind;
/* Dispatch: toasts come from the app (real results); no demo pool. */
export type Toast = { id: number; kind: Kind; title: string; body: string };

const ICON: Record<Kind, LucideIcon> = {
  success: CircleCheck,
  info: Info,
  error: CircleX,
  warning: TriangleAlert
};

const W = 300;
const H = 64;
const SHOWN = 3;
/* a touch under critical: it settles with a hint of give, no wobble */
const SPRING = { type: 'spring', stiffness: 380, damping: 34, mass: 1 } as const;

export function ToastStack({
  toasts,
  onDismiss,
  peek = 14,
  gap = 10,
  corner = 20
}: {
  /* front first */
  toasts: Toast[];
  onDismiss: (id: number) => void;
  peek?: number;
  gap?: number;
  corner?: number;
}) {
  const stack = toasts.slice(0, SHOWN);
  const [leaving, setLeaving] = useState<number | null>(null);
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement | null>(null);

  /* the frame is the open list's size; both states sit in its middle */
  const listH = SHOWN * H + (SHOWN - 1) * gap;
  const stackH = H + (SHOWN - 1) * peek;
  const FH = listH;

  const place = (k: number) => {
    if (open) {
      /* the list: front at the bottom, the rest above it */
      const top = (FH - listH) / 2;
      return { y: top + (SHOWN - 1 - k) * (H + gap), scale: 1 };
    }
    /* the stack: front at the bottom, each one behind a peek higher
       and a step smaller, hanging from its top edge */
    const top = (FH - stackH) / 2;
    const d = Math.min(k, SHOWN - 1);
    return { y: top + (SHOWN - 1 - d) * peek, scale: 1 - d * 0.05 };
  };

  const dismiss = (id: number) => {
    if (leaving !== null) return;
    setLeaving(id);
    window.setTimeout(() => {
      onDismiss(id);
      setLeaving(null);
    }, 220);
  };

  return (
    <div
      ref={root}
      className="tst"
      role="region"
      aria-label="Notifications"
      data-open={open || undefined}
      style={
        {
          width: W,
          height: stack.length ? FH : 0,
          ['--tst-r' as string]: `${corner}px`
        } as CSSProperties
      }
      onPointerOver={() => setOpen(true)}
      onPointerOut={(e) => {
        const to = e.relatedTarget as Node | null;
        if (!to || !root.current?.contains(to)) setOpen(false);
      }}
      onFocus={() => setOpen(true)}
      onBlur={(e) => {
        if (!root.current?.contains(e.relatedTarget as Node | null)) setOpen(false);
      }}
    >
      {stack.map((t, k) => {
        const Icon = ICON[t.kind];
        const out = leaving === t.id;
        const p = place(k);
        const front = k === 0;
        return (
          <motion.div
            key={t.id}
            className="tst-toast"
            data-kind={t.kind}
            data-front={front || undefined}
            style={{ height: H, zIndex: SHOWN - k }}
            /* a new one rises in from below the front */
            initial={{ y: place(0).y + 24, scale: 1, opacity: 0, x: 0 }}
            animate={
              out
                ? { y: p.y, scale: p.scale, opacity: 0, x: 60 }
                : { y: p.y, scale: p.scale, opacity: 1, x: 0 }
            }
            transition={out ? { duration: 0.22, ease: [0.4, 0, 1, 1] } : SPRING}
            aria-hidden={!open && !front ? true : undefined}
          >
            <span className="tst-icon">
              <Icon size={18} strokeWidth={2} aria-hidden="true" />
            </span>
            <span className="tst-text">
              <b>{t.title}</b>
              <span>{t.body}</span>
            </span>
            <button
              type="button"
              className="tst-x"
              aria-label={`Dismiss ${t.title}`}
              tabIndex={open || front ? 0 : -1}
              onClick={() => dismiss(t.id)}
            >
              <X size={16} strokeWidth={2} aria-hidden="true" />
            </button>
          </motion.div>
        );
      })}
    </div>
  );
}
