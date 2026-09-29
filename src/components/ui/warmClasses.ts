/**
 * Class strings for the warm pixel palette (`--ui-*` tokens in styles/globals.css),
 * shared by the menus and dialogs that used to be stock gray-* Tailwind. Kept as
 * literal strings so Tailwind's scanner sees every class.
 */
export const W = {
  backdrop: "fixed inset-0 z-40 flex items-center justify-center bg-black/60",
  modal:
    "bg-[var(--ui-bg-panel)] border border-[var(--ui-border-accent)] shadow-2xl overflow-y-auto text-[var(--ui-text-primary)]",
  modalHeader:
    "flex items-center justify-between px-4 py-2.5 border-b border-[var(--ui-border)] bg-[var(--ui-bg-raised)]",
  title: "text-sm font-bold text-[var(--ui-accent-gold)] tracking-wide",
  close:
    "text-[var(--ui-text-secondary)] hover:text-[var(--ui-text-primary)] text-lg leading-none px-1",
  section: "px-4 py-3 border-b border-[var(--ui-border)] last:border-b-0",
  sectionTitle:
    "text-[10px] font-medium text-[var(--ui-text-secondary)] uppercase tracking-wider mb-2",
  card: "border border-[var(--ui-border)] bg-[var(--ui-bg-raised)]",
  btn:
    "border border-[var(--ui-border)] bg-[var(--ui-bg-raised)] text-[var(--ui-text-primary)] hover:bg-[var(--ui-bg-hover)] hover:border-[var(--ui-border-accent)] transition-colors disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:bg-[var(--ui-bg-raised)] disabled:hover:border-[var(--ui-border)]",
  btnPrimary:
    "border border-[var(--ui-border-accent)] bg-[var(--ui-accent-gold)]/15 text-[var(--ui-accent-gold)] hover:bg-[var(--ui-accent-gold)]/25 transition-colors disabled:opacity-50 disabled:cursor-not-allowed",
  input:
    "w-full bg-[var(--ui-bg-deep)] border border-[var(--ui-border)] px-2.5 py-1.5 text-xs text-[var(--ui-text-primary)] outline-none focus:border-[var(--ui-accent-gold)] placeholder:text-[var(--ui-text-disabled)]",
  muted: "text-[var(--ui-text-secondary)]",
  faint: "text-[var(--ui-text-disabled)]",
} as const;
