import { useEffect, useState } from "react";
import { trpc } from "../../lib/trpc";
import { pushToast } from "../../lib/toast";
import { formatTime, seasonEmoji } from "../../lib/formatters";
import { W } from "./warmClasses";

interface SavesDialogProps {
  onClose: () => void;
  /** After a load replaced the world: App drops its selection, caches are invalidated. */
  onLoaded: () => void;
  /** False while the wizard placeholder is the world — there is no town to save. */
  canSave: boolean;
  /** Suggested name for a new save ("Day 4, spring"). */
  defaultName: string;
}

type Confirm = { kind: "load" | "delete"; id: string; name: string } | null;

/** "Ada, Bram, Clara +10" — the cast is how a player tells two towns apart. */
function castLine(residents: string[]): string {
  if (residents.length === 0) return "no residents";
  const shown = residents.slice(0, 3).map((n) => n.split(" ")[0]).join(", ");
  return residents.length > 3 ? `${shown} +${residents.length - 3}` : shown;
}

function savedAgo(ms: number): string {
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86_400) return `${Math.floor(s / 3600)} h ago`;
  return new Date(ms).toLocaleDateString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function sizeLabel(bytes: number): string {
  return bytes >= 1_048_576 ? `${(bytes / 1_048_576).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/**
 * Save slots: keep a town worth keeping, or branch one ("what if I reveal
 * this?") and come back. The server pauses the game while it copies, so a
 * save is always of whole ticks. Autosaves (one per game day, last three kept)
 * show up here too.
 */
export function SavesDialog({ onClose, onLoaded, canSave, defaultName }: SavesDialogProps) {
  const [name, setName] = useState("");
  const [confirm, setConfirm] = useState<Confirm>(null);

  // Not on any dirty channel (saves change only when someone saves), so read
  // fresh every time the dialog opens.
  const { data: saves, isLoading } = trpc.saves.list.useQuery(undefined, {
    staleTime: 0,
    refetchOnMount: "always",
  });
  const utils = trpc.useUtils();

  const saveMutation = trpc.saves.save.useMutation({
    onSuccess: (meta) => {
      setName("");
      pushToast(`Saved “${meta.name}”`, "success", "💾");
      void utils.saves.list.invalidate();
    },
    onError: (err) => pushToast(err.message || "Couldn't save the town", "error", "💾"),
  });

  const loadMutation = trpc.saves.load.useMutation({
    onSuccess: (meta) => {
      setConfirm(null);
      pushToast(`Loaded “${meta.name}” — Day ${meta.day}`, "success", "💾");
      onLoaded();
      onClose();
    },
    onError: (err) => {
      setConfirm(null);
      pushToast(err.message || "Couldn't load that save — your town is unchanged", "error", "💾");
    },
  });

  const deleteMutation = trpc.saves.delete.useMutation({
    onSuccess: () => {
      setConfirm(null);
      pushToast("Save deleted", "info", "🗑");
      void utils.saves.list.invalidate();
    },
    onError: (err) => {
      setConfirm(null);
      pushToast(err.message || "Couldn't delete that save", "error");
    },
  });

  const busy = saveMutation.isPending || loadMutation.isPending || deleteMutation.isPending;

  // App owns the Escape chain and can't see this dialog: capture phase +
  // stopPropagation (as TopBar's confirm does), so Escape backs out of the
  // confirmation first, then closes the dialog — never a panel underneath.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      if (busy) return;
      if (confirm) setConfirm(null);
      else onClose();
    };
    document.addEventListener("keydown", handler, true);
    return () => document.removeEventListener("keydown", handler, true);
  }, [confirm, busy, onClose]);

  const submitSave = () => {
    if (!canSave || busy) return;
    saveMutation.mutate({ name: name.trim() || defaultName });
  };

  const runConfirm = () => {
    if (!confirm) return;
    if (confirm.kind === "load") loadMutation.mutate({ id: confirm.id });
    else deleteMutation.mutate({ id: confirm.id });
  };

  return (
    <div className={W.backdrop} onClick={() => !busy && onClose()}>
      <div
        className={`${W.modal} relative w-[520px] max-w-[95vw] max-h-[85vh] flex flex-col`}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label="Saves"
      >
        <div className={W.modalHeader}>
          <h2 className={W.title}>💾 Saves</h2>
          <button onClick={onClose} disabled={busy} className={W.close} aria-label="Close">
            ×
          </button>
        </div>

        {/* Save as… */}
        <div className={W.section}>
          <div className={W.sectionTitle}>Save as…</div>
          <form
            className="flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              submitSave();
            }}
          >
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={defaultName}
              maxLength={80}
              disabled={!canSave || busy}
              className={W.input}
              aria-label="Save name"
            />
            <button
              type="submit"
              disabled={!canSave || busy}
              className={`px-3 py-1.5 text-xs font-medium whitespace-nowrap ${W.btnPrimary}`}
            >
              {saveMutation.isPending ? "Saving…" : "Save"}
            </button>
          </form>
          <p className={`mt-1.5 text-[11px] ${W.faint}`}>
            {canSave
              ? "The town pauses for a moment while it's copied. A new autosave is made every game day."
              : "Start a town first — there is nothing to save yet."}
          </p>
        </div>

        {/* Slots */}
        <div className="flex-1 overflow-y-auto px-4 py-3">
          <div className={W.sectionTitle}>Saved towns</div>
          {isLoading ? (
            <p className={`text-xs ${W.muted} py-4 text-center`}>Reading the saves…</p>
          ) : !saves || saves.length === 0 ? (
            <p className={`text-xs ${W.muted} py-6 text-center italic`}>
              No saves yet. Save before you stir something up — you can always come back.
            </p>
          ) : (
            <ul className="space-y-2">
              {saves.map((s) => (
                <li key={s.id} className={`${W.card} px-3 py-2 flex items-center gap-3`}>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium truncate" title={s.name}>{s.name}</span>
                      {s.kind === "auto" && (
                        <span className="text-[9px] uppercase tracking-wider px-1 border border-ui-line text-ui-dim shrink-0">
                          auto
                        </span>
                      )}
                    </div>
                    <div className={`text-[11px] ${W.muted}`}>
                      <span className="text-ui-gold">Day {s.day}</span>
                      {" · "}
                      <span className="capitalize">{seasonEmoji(s.season)} {s.season}</span>
                      {" · "}
                      {formatTime(s)}
                      {" · "}
                      <span title={s.residents.join(", ")}>{castLine(s.residents)}</span>
                    </div>
                    <div className={`text-[10px] ${W.faint}`} title={new Date(s.createdAt).toLocaleString()}>
                      saved {savedAgo(s.createdAt)} · {sizeLabel(s.sizeBytes)}
                    </div>
                  </div>
                  <button
                    onClick={() => setConfirm({ kind: "load", id: s.id, name: s.name })}
                    disabled={busy}
                    className={`px-2.5 py-1 text-xs ${W.btn}`}
                  >
                    Load
                  </button>
                  <button
                    onClick={() => setConfirm({ kind: "delete", id: s.id, name: s.name })}
                    disabled={busy}
                    title="Delete this save"
                    className={`px-2 py-1 text-xs ${W.btn} hover:!border-ui-bad/60 hover:!text-ui-bad`}
                    aria-label={`Delete ${s.name}`}
                  >
                    🗑
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* Confirmation, over the dialog rather than a second modal. */}
        {confirm && (
          <div className="absolute inset-0 z-10 flex items-center justify-center bg-black/60 p-6">
            <div className="bg-ui-panel border border-ui-line p-5 max-w-sm shadow-xl">
              <h3 className="text-base font-bold mb-2">
                {confirm.kind === "load" ? `Load “${confirm.name}”?` : `Delete “${confirm.name}”?`}
              </h3>
              <p className="text-sm text-ui-dim mb-5">
                {confirm.kind === "load"
                  ? "Unsaved progress since your last save will be lost."
                  : "The save file is removed for good. Your running town is not affected."}
              </p>
              <div className="flex justify-end gap-3">
                <button
                  onClick={() => setConfirm(null)}
                  disabled={busy}
                  className="px-4 py-2 text-sm bg-ui-raised hover:bg-ui-hover border border-ui-line rounded-sm transition-colors disabled:opacity-50"
                >
                  Cancel
                </button>
                <button
                  onClick={runConfirm}
                  disabled={busy}
                  className={`px-4 py-2 text-sm rounded-sm transition-colors font-semibold text-ui-deep hover:brightness-110 disabled:opacity-60 ${
                    confirm.kind === "delete" ? "bg-ui-bad" : "bg-ui-gold"
                  }`}
                >
                  {confirm.kind === "load"
                    ? loadMutation.isPending ? "Loading…" : "Load"
                    : deleteMutation.isPending ? "Deleting…" : "Delete"}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
