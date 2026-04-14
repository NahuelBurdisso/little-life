import { useState, useCallback } from 'react';
import type { SliderConfig, AgentConfig } from './types';

// ── Types ─────────────────────────────────────────────────────────────────────

type Mood = 'happy' | 'content' | 'anxious' | 'angry' | 'suspicious' | 'romantic' | 'lonely';

interface AgentMood {
  name: string;
  mood: Mood;
}

type Sensitivity = 'low' | 'medium' | 'high' | 'explosive';

interface Secret {
  holder: string;
  text: string;
  sensitivity: Sensitivity;
}

interface RomanceThread {
  agentA: string;
  agentB: string;
  tension: number; // 0-100
  status: 'crush' | 'mutual' | 'unrequited' | 'complicated';
}

interface RivalPair {
  agentA: string;
  agentB: string;
  reason: string;
}

interface DramaConfig {
  agentMoods: AgentMood[];
  secrets: Secret[];
  romanceThreads: RomanceThread[];
  rivalPairs: RivalPair[];
}

// ── Deterministic-ish seeded RNG ──────────────────────────────────────────────
// We use a simple mulberry32 so "Regenerate" clicks give varied but stable results.

function mulberry32(seed: number) {
  let s = seed;
  return () => {
    s |= 0; s = s + 0x6d2b79f5 | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = t + Math.imul(t ^ (t >>> 7), 61 | t) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ── Drama generation ──────────────────────────────────────────────────────────

const MOODS: Mood[] = ['happy', 'content', 'anxious', 'angry', 'suspicious', 'romantic', 'lonely'];

const SECRET_TEMPLATES = [
  (name: string) => `${name} has been secretly skimming money from the community fund.`,
  (name: string) => `${name} is hiding a past under a different identity.`,
  (name: string) => `${name} sabotaged a rival's business out of jealousy.`,
  (name: string) => `${name} has been forging documents for years.`,
  (name: string) => `${name} witnessed a crime but stayed silent to protect someone.`,
  (name: string) => `${name} is secretly in love with someone already taken.`,
  (name: string) => `${name} has a child nobody in town knows about.`,
  (name: string) => `${name} owes a dangerous debt to someone outside of town.`,
  (name: string) => `${name} has been reading other people's mail.`,
  (name: string) => `${name} burned down a building years ago and was never caught.`,
];

const ROMANCE_STATUSES: RomanceThread['status'][] = ['crush', 'mutual', 'unrequited', 'complicated'];

const RIVAL_REASONS = [
  'a disputed inheritance',
  'a decades-old public humiliation',
  'stolen credit for an idea',
  'a broken engagement',
  'competing for the same promotion',
  'a long-running property dispute',
  'betrayal during a crisis',
  'a love triangle gone sour',
];

function generateDramaConfig(
  sliders: SliderConfig,
  agents: AgentConfig[],
  seed: number,
): DramaConfig {
  const rng = mulberry32(seed);
  const names = agents.map((a) => a.name);

  // ── Moods ──
  const agentMoods: AgentMood[] = names.map((name) => {
    // bias mood based on drama + trust
    const angryChance = sliders.drama / 200;      // 0–0.5
    const happyChance = sliders.trust / 150;       // 0–0.66
    const romanticChance = sliders.romance / 200;  // 0–0.5
    const r = rng();
    let mood: Mood;
    if (r < angryChance)                          mood = rng() > 0.5 ? 'angry' : 'suspicious';
    else if (r < angryChance + romanticChance)    mood = 'romantic';
    else if (r < angryChance + romanticChance + happyChance) mood = rng() > 0.5 ? 'happy' : 'content';
    else                                           mood = MOODS[Math.floor(rng() * MOODS.length)];
    return { name, mood };
  });

  // ── Secrets ──
  const secretCount = Math.max(1, Math.round((sliders.drama + sliders.crime) / 40));
  const secrets: Secret[] = [];
  const usedNames = new Set<string>();
  for (let i = 0; i < Math.min(secretCount, names.length); i++) {
    let name = names[Math.floor(rng() * names.length)];
    // try not to repeat the same person
    let attempts = 0;
    while (usedNames.has(name) && attempts < 8) { name = names[Math.floor(rng() * names.length)]; attempts++; }
    usedNames.add(name);
    const template = SECRET_TEMPLATES[Math.floor(rng() * SECRET_TEMPLATES.length)];
    const sensitivityRoll = rng();
    const sensitivity: Sensitivity =
      sensitivityRoll < 0.25 ? 'low' :
      sensitivityRoll < 0.55 ? 'medium' :
      sensitivityRoll < 0.80 ? 'high' : 'explosive';
    secrets.push({ holder: name, text: template(name), sensitivity });
  }

  // ── Romance threads ──
  const romanceCount = Math.max(0, Math.round(sliders.romance / 35));
  const romanceThreads: RomanceThread[] = [];
  const usedPairs = new Set<string>();
  for (let i = 0; i < Math.min(romanceCount, Math.floor(names.length / 2)); i++) {
    let a = names[Math.floor(rng() * names.length)];
    let b = names[Math.floor(rng() * names.length)];
    let attempts = 0;
    while ((a === b || usedPairs.has(`${a}-${b}`) || usedPairs.has(`${b}-${a}`)) && attempts < 10) {
      a = names[Math.floor(rng() * names.length)];
      b = names[Math.floor(rng() * names.length)];
      attempts++;
    }
    if (a === b) continue;
    usedPairs.add(`${a}-${b}`);
    romanceThreads.push({
      agentA: a,
      agentB: b,
      tension: Math.round(40 + rng() * 60),
      status: ROMANCE_STATUSES[Math.floor(rng() * ROMANCE_STATUSES.length)],
    });
  }

  // ── Rival pairs ──
  const rivalCount = Math.max(0, Math.round((sliders.drama + (100 - sliders.trust)) / 60));
  const rivalPairs: RivalPair[] = [];
  const usedRivalPairs = new Set<string>();
  for (let i = 0; i < Math.min(rivalCount, Math.floor(names.length / 2)); i++) {
    let a = names[Math.floor(rng() * names.length)];
    let b = names[Math.floor(rng() * names.length)];
    let attempts = 0;
    while ((a === b || usedRivalPairs.has(`${a}-${b}`) || usedRivalPairs.has(`${b}-${a}`)) && attempts < 10) {
      a = names[Math.floor(rng() * names.length)];
      b = names[Math.floor(rng() * names.length)];
      attempts++;
    }
    if (a === b) continue;
    usedRivalPairs.add(`${a}-${b}`);
    rivalPairs.push({
      agentA: a,
      agentB: b,
      reason: RIVAL_REASONS[Math.floor(rng() * RIVAL_REASONS.length)],
    });
  }

  return { agentMoods, secrets, romanceThreads, rivalPairs };
}

// ── Mood display helpers ──────────────────────────────────────────────────────

const MOOD_META: Record<Mood, { emoji: string; colour: string }> = {
  happy:      { emoji: '😊', colour: 'bg-yellow-500/20 text-yellow-300 border-yellow-700/40' },
  content:    { emoji: '😌', colour: 'bg-green-900/30 text-green-300 border-green-700/40'  },
  anxious:    { emoji: '😰', colour: 'bg-purple-900/30 text-purple-300 border-purple-700/40' },
  angry:      { emoji: '😤', colour: 'bg-red-900/30 text-red-300 border-red-700/40'       },
  suspicious: { emoji: '🤨', colour: 'bg-orange-900/30 text-orange-300 border-orange-700/40' },
  romantic:   { emoji: '😍', colour: 'bg-pink-900/30 text-pink-300 border-pink-700/40'    },
  lonely:     { emoji: '😔', colour: 'bg-gray-700/40 text-gray-400 border-gray-600/40'    },
};

const SENSITIVITY_META: Record<Sensitivity, { label: string; colour: string }> = {
  low:      { label: 'Low',      colour: 'bg-gray-700/50 text-gray-400'           },
  medium:   { label: 'Medium',   colour: 'bg-yellow-900/40 text-yellow-300'       },
  high:     { label: 'High',     colour: 'bg-orange-900/40 text-orange-300'       },
  explosive:{ label: 'Explosive',colour: 'bg-red-900/50 text-red-300 font-bold'  },
};

const ROMANCE_STATUS_LABEL: Record<RomanceThread['status'], string> = {
  crush:       'Crush',
  mutual:      'Mutual',
  unrequited:  'Unrequited',
  complicated: 'Complicated',
};

// ── Sub-sections ──────────────────────────────────────────────────────────────

function SummaryBar({ config }: { config: DramaConfig }) {
  const trustDelta = config.agentMoods.filter(
    (m) => m.mood === 'happy' || m.mood === 'content'
  ).length - config.agentMoods.filter(
    (m) => m.mood === 'angry' || m.mood === 'suspicious'
  ).length;

  const items = [
    { label: 'Secrets',  value: config.secrets.length,       colour: 'text-amber-400'  },
    { label: 'Romances', value: config.romanceThreads.length, colour: 'text-pink-400'   },
    { label: 'Rivals',   value: config.rivalPairs.length,     colour: 'text-red-400'    },
    {
      label: 'Trust δ',
      value: (trustDelta >= 0 ? '+' : '') + trustDelta,
      colour: trustDelta >= 0 ? 'text-emerald-400' : 'text-red-400',
    },
  ];

  return (
    <div className="grid grid-cols-4 gap-2 mb-4">
      {items.map(({ label, value, colour }) => (
        <div key={label} className="bg-gray-800 rounded-lg p-3 text-center border border-gray-700">
          <div className={`text-xl font-bold ${colour}`}>{value}</div>
          <div className="text-[10px] text-gray-500 mt-0.5">{label}</div>
        </div>
      ))}
    </div>
  );
}

function MoodGrid({ moods }: { moods: AgentMood[] }) {
  return (
    <div className="mb-4">
      <h4 className="text-xs text-gray-500 uppercase font-medium mb-2">Agent Moods</h4>
      <div className="flex flex-wrap gap-1.5">
        {moods.map(({ name, mood }) => {
          const meta = MOOD_META[mood];
          return (
            <span
              key={name}
              className={`
                inline-flex items-center gap-1 text-[11px] px-2 py-1 rounded-lg border
                ${meta.colour}
              `}
            >
              <span>{meta.emoji}</span>
              <span>{name.split(' ')[0]}</span>
            </span>
          );
        })}
      </div>
    </div>
  );
}

function SecretList({ secrets }: { secrets: Secret[] }) {
  if (secrets.length === 0) return null;
  return (
    <div className="mb-4">
      <h4 className="text-xs text-gray-500 uppercase font-medium mb-2">Secrets</h4>
      <div className="space-y-1.5">
        {secrets.map((s, i) => {
          const sm = SENSITIVITY_META[s.sensitivity];
          return (
            <div
              key={i}
              className="flex items-start gap-2 bg-gray-800 rounded-lg p-2.5 border border-gray-700"
            >
              <span className="text-gray-500 text-xs mt-0.5 shrink-0">🤫</span>
              <p className="text-[11px] text-gray-300 flex-1 leading-snug">{s.text}</p>
              <span className={`shrink-0 text-[9px] px-1.5 py-0.5 rounded-full ${sm.colour}`}>
                {sm.label}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function RomanceList({ threads }: { threads: RomanceThread[] }) {
  if (threads.length === 0) return null;
  return (
    <div className="mb-4">
      <h4 className="text-xs text-gray-500 uppercase font-medium mb-2">Romance Threads</h4>
      <div className="space-y-1.5">
        {threads.map((t, i) => (
          <div
            key={i}
            className="flex items-center gap-2 bg-gray-800 rounded-lg p-2.5 border border-gray-700"
          >
            <span className="text-pink-400 text-xs">💕</span>
            <span className="text-[11px] text-white">
              {t.agentA.split(' ')[0]}
              <span className="text-gray-500 mx-1">&amp;</span>
              {t.agentB.split(' ')[0]}
            </span>
            <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-pink-900/30 text-pink-300 border border-pink-700/40">
              {ROMANCE_STATUS_LABEL[t.status]}
            </span>
            {/* Tension bar */}
            <div className="ml-auto flex items-center gap-1.5">
              <div className="w-16 h-1.5 bg-gray-700 rounded-full overflow-hidden">
                <div
                  className="h-full bg-pink-500 rounded-full"
                  style={{ width: `${t.tension}%` }}
                />
              </div>
              <span className="text-[10px] text-gray-500">{t.tension}</span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function RivalList({ rivals }: { rivals: RivalPair[] }) {
  if (rivals.length === 0) return null;
  return (
    <div className="mb-4">
      <h4 className="text-xs text-gray-500 uppercase font-medium mb-2">Rival Pairs</h4>
      <div className="space-y-1.5">
        {rivals.map((r, i) => (
          <div
            key={i}
            className="flex items-center gap-2 bg-gray-800 rounded-lg p-2.5 border border-gray-700"
          >
            <span className="text-red-400 text-xs">⚔️</span>
            <span className="text-[11px] text-white">
              {r.agentA.split(' ')[0]}
              <span className="text-gray-500 mx-1">vs</span>
              {r.agentB.split(' ')[0]}
            </span>
            <span className="ml-auto text-[10px] text-gray-500 italic">{r.reason}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── SimulationPreview ─────────────────────────────────────────────────────────

interface SimulationPreviewProps {
  sliders: SliderConfig;
  agents: AgentConfig[];
}

export function SimulationPreview({ sliders, agents }: SimulationPreviewProps) {
  const [seed, setSeed] = useState(() => Math.floor(Math.random() * 0xffffff));

  const config = generateDramaConfig(sliders, agents, seed);

  const regenerate = useCallback(() => {
    setSeed(Math.floor(Math.random() * 0xffffff));
  }, []);

  return (
    <div>
      {/* Section header */}
      <div className="flex items-center justify-between mb-3">
        <div>
          <h3 className="text-sm font-semibold text-white">Simulation Preview</h3>
          <p className="text-[11px] text-gray-500 mt-0.5">
            A snapshot of what your town's first day might look like.
          </p>
        </div>
        <button
          onClick={regenerate}
          className="flex items-center gap-1.5 px-3 py-1.5 text-xs bg-gray-700 hover:bg-gray-600 rounded-lg text-gray-300 hover:text-white transition-colors border border-gray-600"
        >
          <span>↺</span>
          Regenerate
        </button>
      </div>

      <SummaryBar config={config} />
      <MoodGrid moods={config.agentMoods} />
      <SecretList secrets={config.secrets} />
      <RomanceList threads={config.romanceThreads} />
      <RivalList rivals={config.rivalPairs} />
    </div>
  );
}
