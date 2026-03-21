import { useState } from "react";
import { useNudge } from "../../hooks/useNudge";

interface NewAgentDialogProps {
  isOpen: boolean;
  onClose: () => void;
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

export function NewAgentDialog({ isOpen, onClose }: NewAgentDialogProps) {
  const [name, setName] = useState("");
  const [bio, setBio] = useState("");
  const [traits, setTraits] = useState<string[]>([]);
  const [job, setJob] = useState("unemployed");
  const { introduceAgent } = useNudge();

  if (!isOpen) return null;

  const toggleTrait = (trait: string) => {
    setTraits((prev) =>
      prev.includes(trait) ? prev.filter((t) => t !== trait) : [...prev, trait]
    );
  };

  const handleSubmit = () => {
    if (!name.trim()) return;
    introduceAgent(name.trim(), bio.trim(), traits, job);
    setName("");
    setBio("");
    setTraits([]);
    setJob("unemployed");
    onClose();
  };

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/50" onClick={onClose}>
      <div
        className="bg-gray-800 border border-gray-600 rounded-xl shadow-2xl w-[420px] max-h-[80vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3 border-b border-gray-700">
          <h2 className="text-sm font-bold text-white">New Resident</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-white text-lg leading-none">
            &times;
          </button>
        </div>

        <div className="px-5 py-4 space-y-4">
          {/* Name */}
          <div>
            <label className="block text-xs text-gray-400 mb-1">Name</label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Enter name..."
              className="w-full bg-gray-700 border border-gray-600 rounded px-3 py-1.5 text-sm text-white outline-none focus:border-blue-500"
            />
          </div>

          {/* Bio */}
          <div>
            <label className="block text-xs text-gray-400 mb-1">Bio</label>
            <textarea
              value={bio}
              onChange={(e) => setBio(e.target.value)}
              placeholder="A short backstory..."
              rows={3}
              className="w-full bg-gray-700 border border-gray-600 rounded px-3 py-1.5 text-sm text-white outline-none focus:border-blue-500 resize-none"
            />
          </div>

          {/* Traits */}
          <div>
            <label className="block text-xs text-gray-400 mb-1.5">
              Traits ({traits.length} selected)
            </label>
            <div className="flex flex-wrap gap-1.5">
              {TRAIT_OPTIONS.map((trait) => {
                const selected = traits.includes(trait);
                return (
                  <button
                    key={trait}
                    onClick={() => toggleTrait(trait)}
                    className={`px-2 py-0.5 text-xs rounded-full border transition-colors ${
                      selected
                        ? "bg-blue-600/30 border-blue-500 text-blue-300"
                        : "bg-gray-700 border-gray-600 text-gray-400 hover:border-gray-500"
                    }`}
                  >
                    {trait}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Job */}
          <div>
            <label className="block text-xs text-gray-400 mb-1">Job</label>
            <select
              value={job}
              onChange={(e) => setJob(e.target.value)}
              className="w-full bg-gray-700 border border-gray-600 rounded px-3 py-1.5 text-sm text-white outline-none focus:border-blue-500"
            >
              {JOB_OPTIONS.map((j) => (
                <option key={j} value={j}>
                  {j.charAt(0).toUpperCase() + j.slice(1)}
                </option>
              ))}
            </select>
          </div>

          {/* Submit */}
          <button
            onClick={handleSubmit}
            disabled={!name.trim()}
            className={`w-full py-2 text-sm font-medium rounded transition-colors ${
              name.trim()
                ? "bg-green-600 hover:bg-green-500 text-white"
                : "bg-gray-600 text-gray-500 cursor-not-allowed"
            }`}
          >
            Introduce to Town
          </button>
        </div>
      </div>
    </div>
  );
}
