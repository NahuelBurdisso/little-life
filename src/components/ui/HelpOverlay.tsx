import { useEscapeClose } from "../../hooks/useEscapeClose";
import { HOTKEYS, VERBS } from "../../lib/helpContent";
import { W } from "./warmClasses";

interface HelpOverlayProps {
  isOpen: boolean;
  onClose: () => void;
  /** Reopen the residents overview from here. */
  onMeetTheTown: () => void;
}

function Key({ children }: { children: string }) {
  return (
    <kbd className="min-w-[1.75rem] text-center px-1.5 py-0.5 text-[11px] border border-[var(--ui-border-accent)] bg-[var(--ui-bg-deep)] text-[var(--ui-accent-gold)]">
      {children}
    </kbd>
  );
}

/** The "?" overlay: every hotkey and the player's verbs on one screen. */
export function HelpOverlay({ isOpen, onClose, onMeetTheTown }: HelpOverlayProps) {
  useEscapeClose(isOpen, onClose);
  if (!isOpen) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label="Help"
    >
      <div className={`${W.modal} w-[720px] max-w-full max-h-[90vh]`} onClick={(e) => e.stopPropagation()}>
        <div className={W.modalHeader}>
          <h2 className={`${W.title} text-base`}>How to play</h2>
          <button onClick={onClose} className={W.close} aria-label="Close">
            &times;
          </button>
        </div>

        <div className={W.section}>
          <div className={W.sectionTitle}>You are the town's invisible hand</div>
          <ul className="flex flex-col gap-2">
            {VERBS.map((v) => (
              <li key={v.how} className="flex items-start gap-2.5 text-xs">
                <span aria-hidden className="w-5 text-center text-sm leading-none">
                  {v.icon}
                </span>
                <span>
                  <span className="font-semibold text-[var(--ui-text-primary)]">{v.how}</span>
                  <span className={W.muted}> — {v.what}</span>
                </span>
              </li>
            ))}
          </ul>
        </div>

        <div className={W.section}>
          <div className={W.sectionTitle}>Hotkeys</div>
          <ul className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-1.5">
            {HOTKEYS.map((h) => (
              <li key={h.keys.join("+")} className="flex items-center gap-2 text-xs">
                <span className="flex gap-1 shrink-0">
                  {h.keys.map((k) => (
                    <Key key={k}>{k}</Key>
                  ))}
                </span>
                <span className={W.muted}>{h.what}</span>
              </li>
            ))}
          </ul>
        </div>

        <div className="flex items-center justify-between px-4 py-2.5 bg-[var(--ui-bg-raised)]">
          <button
            onClick={() => {
              onClose();
              onMeetTheTown();
            }}
            className={`px-3 py-1.5 text-xs ${W.btn}`}
          >
            🏘️ Meet the town again
          </button>
          <button onClick={onClose} className={`px-4 py-1.5 text-xs font-semibold ${W.btnPrimary}`}>
            Got it
          </button>
        </div>
      </div>
    </div>
  );
}
