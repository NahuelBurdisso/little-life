import { useState } from "react";
import { useNudge } from "../../hooks/useNudge";
import { W } from "./warmClasses";

interface NewAgentDialogProps {
  isOpen: boolean;
  onClose: () => void;
  /** Called with the newcomer's id once the server accepted them. */
  onCreated?: (agentId: number) => void;
}

const TRAIT_OPTIONS = [
  "hardworking", "lazy", "introverted", "extroverted",
  "generous", "shrewd", "creative", "practical",
  "optimistic", "skeptical", "patient", "impulsive",
  "caring", "independent",
];

const JOB_OPTIONS = [
  "farmer", "shopkeeper", "bartender", "doctor",
  "handyperson", "musician", "baker", "unemployed",
];

export function NewAgentDialog({ isOpen, onClose, onCreated }: NewAgentDialogProps) {
  const [name, setName] = useState("");
  const [bio, setBio] = useState("");
  const [traits, setTraits] = useState<string[]>([]);
  const [job, setJob] = useState("unemployed");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { introduceAgent } = useNudge();

  if (!isOpen) return null;

  const toggleTrait = (trait: string) => {
    setTraits((prev) =>
      prev.includes(trait) ? prev.filter((t) => t !== trait) : [...prev, trait]
    );
  };

  const close = () => {
    setError(null);
    onClose();
  };

  const canSubmit = name.trim().length > 0 && !pending;

  // The form only resets once the server said yes. It used to clear and close
  // straight away, so a refusal ("No available housing") threw away everything the
  // player had typed and the dialog looked as if it had worked.
  const handleSubmit = async () => {
    if (!canSubmit) return;
    setPending(true);
    setError(null);
    const result = await introduceAgent(name.trim(), bio.trim(), traits, job);
    setPending(false);
    if (!result.success) {
      setError(
        result.reason === "network"
          ? "Could not reach the server. Try again."
          : result.reason ?? "The town could not take them in.",
      );
      return;
    }
    setName("");
    setBio("");
    setTraits([]);
    setJob("unemployed");
    onClose();
    if (result.agentId != null) onCreated?.(result.agentId);
  };

  return (
    <div className={W.backdrop} onClick={close}>
      <div
        className={`${W.modal} w-[420px] max-w-[95vw] max-h-[85vh]`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className={W.modalHeader}>
          <h2 className={W.title}>New Resident</h2>
          <button onClick={close} className={W.close} aria-label="Close">
            &times;
          </button>
        </div>

        <div className="px-4 py-4 space-y-4">
          <div>
            <label className={`block text-[10px] uppercase tracking-wider ${W.muted} mb-1`}>Name</label>
            <input
              type="text"
              value={name}
              autoFocus
              disabled={pending}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") handleSubmit();
              }}
              placeholder="Enter name..."
              className={W.input}
            />
          </div>

          <div>
            <label className={`block text-[10px] uppercase tracking-wider ${W.muted} mb-1`}>Bio</label>
            <textarea
              value={bio}
              disabled={pending}
              onChange={(e) => setBio(e.target.value)}
              placeholder="A short backstory..."
              rows={3}
              className={`${W.input} resize-none`}
            />
          </div>

          <div>
            <label className={`block text-[10px] uppercase tracking-wider ${W.muted} mb-1.5`}>
              Traits ({traits.length} selected)
            </label>
            <div className="flex flex-wrap gap-1.5">
              {TRAIT_OPTIONS.map((trait) => {
                const selected = traits.includes(trait);
                return (
                  <button
                    key={trait}
                    type="button"
                    disabled={pending}
                    aria-pressed={selected}
                    onClick={() => toggleTrait(trait)}
                    className={`px-2 py-0.5 text-xs border transition-colors ${
                      selected
                        ? "bg-[var(--ui-accent-gold)]/15 border-[var(--ui-accent-gold)] text-[var(--ui-accent-gold)]"
                        : "bg-[var(--ui-bg-raised)] border-[var(--ui-border)] text-[var(--ui-text-secondary)] hover:border-[var(--ui-border-accent)]"
                    }`}
                  >
                    {trait}
                  </button>
                );
              })}
            </div>
          </div>

          <div>
            <label className={`block text-[10px] uppercase tracking-wider ${W.muted} mb-1`}>Job</label>
            <select
              value={job}
              disabled={pending}
              onChange={(e) => setJob(e.target.value)}
              className={W.input}
            >
              {JOB_OPTIONS.map((j) => (
                <option key={j} value={j}>
                  {j.charAt(0).toUpperCase() + j.slice(1)}
                </option>
              ))}
            </select>
          </div>

          {error && (
            <p
              role="alert"
              className="text-xs px-2.5 py-1.5 border border-[var(--ui-negative)] bg-[var(--ui-negative)]/10 text-[var(--ui-negative)]"
            >
              {error}
            </p>
          )}

          <button
            onClick={handleSubmit}
            disabled={!canSubmit}
            aria-busy={pending}
            className={`w-full py-2 text-sm font-medium ${W.btnPrimary}`}
          >
            {pending ? "Introducing…" : "Introduce to Town"}
          </button>
        </div>
      </div>
    </div>
  );
}
