import { dismissToast, useToasts, type ToastTone } from '../../lib/toast';

const TONE_STYLE: Record<ToastTone, { border: string; glyph: string }> = {
  success: { border: 'var(--ui-accent-gold)', glyph: '✦' },
  info: { border: 'var(--ui-accent-blue)', glyph: '•' },
  warning: { border: 'var(--ui-warning)', glyph: '!' },
  error: { border: 'var(--ui-negative)', glyph: '✕' },
};

/** Bottom-centre stack of toasts (see `lib/toast.ts`). Click one to dismiss it. */
export function Toasts() {
  const toasts = useToasts();
  if (toasts.length === 0) return null;
  return (
    <div className="fixed bottom-20 left-1/2 -translate-x-1/2 z-50 flex flex-col items-center gap-1.5 pointer-events-none">
      {toasts.map((t) => {
        const s = TONE_STYLE[t.tone];
        return (
          <button
            key={t.id}
            onClick={() => dismissToast(t.id)}
            className="toast-in pointer-events-auto flex items-center gap-2 px-3 py-1.5 text-xs rounded shadow-lg"
            style={{
              background: 'var(--ui-bg-panel)',
              color: 'var(--ui-text-primary)',
              border: '1px solid var(--ui-border)',
              borderLeft: `3px solid ${s.border}`,
            }}
          >
            <span style={{ color: s.border }}>{t.icon ?? s.glyph}</span>
            <span>{t.message}</span>
          </button>
        );
      })}
    </div>
  );
}
