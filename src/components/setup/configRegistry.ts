/**
 * Simulation Config Registry
 *
 * Single source of truth for all configurable simulation parameters.
 * To add a new setting: add one entry here.
 * - UI auto-generates the control
 * - Server accepts it without schema changes
 * - Simulation reads it with fallback to default — but only once a system
 *   actually reads the key. The live rules go through server/lib/worldRules.ts
 *   (option lists and defaults from server/data/rulesCatalog.ts, used below so
 *   the two can't drift); tickSpeed and startingMoney are applied once by
 *   setup.ts. A key nothing reads is a control that lies to the player.
 *
 * There is no LLM category any more: the model, temperature and token limits
 * are the server's `.env` / CONFIG.AI, shared by every world. The wizard's
 * copies were never read, and the model default had gone stale (a model the
 * project no longer runs), so they only misled.
 */

import { DEFAULT_LIVE_RULES, DRAMA_LEVELS, SICKNESS_LEVELS } from '../../../server/data/rulesCatalog';

export interface ConfigParam {
  key: string;
  label: string;
  description: string;
  type: 'toggle' | 'slider' | 'select' | 'text';
  default: boolean | number | string;
  category: 'simulation' | 'economy';
  min?: number;
  max?: number;
  step?: number;
  options?: string[];
  unit?: string;
}

export const CONFIG_REGISTRY: ConfigParam[] = [
  // === Simulation ===
  {
    key: 'deathEnabled', label: 'Death Enabled',
    description: 'Agents can die from neglect, sickness, or old age',
    type: 'toggle', default: DEFAULT_LIVE_RULES.deathEnabled, category: 'simulation',
  },
  {
    key: 'sicknessRate', label: 'Sickness Rate',
    description: 'How often agents get sick from the environment',
    type: 'select', default: DEFAULT_LIVE_RULES.sicknessRate, category: 'simulation',
    options: [...SICKNESS_LEVELS],
  },
  {
    key: 'contagionRate', label: 'Contagion Rate',
    description: 'How easily sickness spreads between agents',
    type: 'select', default: DEFAULT_LIVE_RULES.contagionRate, category: 'simulation',
    options: [...SICKNESS_LEVELS],
  },
  {
    key: 'dramaIntensity', label: 'Drama Intensity',
    description: 'Random events, dark dynamics (theft, jealousy, grudges) and how short tempers run',
    type: 'select', default: DEFAULT_LIVE_RULES.dramaIntensity, category: 'simulation',
    options: [...DRAMA_LEVELS],
  },
  {
    key: 'tickSpeed', label: 'Tick Speed',
    description: 'Simulation speed multiplier',
    type: 'slider', default: 1, category: 'simulation',
    min: 0.5, max: 4, step: 0.5, unit: 'x',
  },

  // === Economy ===
  {
    key: 'startingMoney', label: 'Starting Money',
    description: 'How much money each agent starts with',
    type: 'slider', default: 50, category: 'economy',
    min: 10, max: 500, step: 10, unit: '$',
  },
];

// --- Helpers ---

export function getDefaultRules(): Record<string, boolean | number | string> {
  const defaults: Record<string, boolean | number | string> = {};
  for (const param of CONFIG_REGISTRY) {
    defaults[param.key] = param.default;
  }
  return defaults;
}

export function getCategories(): string[] {
  return [...new Set(CONFIG_REGISTRY.map(p => p.category))];
}

export function getParamsByCategory(category: string): ConfigParam[] {
  return CONFIG_REGISTRY.filter(p => p.category === category);
}

const CATEGORY_LABELS: Record<string, { label: string; icon: string }> = {
  simulation: { label: 'Simulation', icon: '🎮' },
  economy: { label: 'Economy', icon: '💰' },
};

export function getCategoryLabel(category: string): { label: string; icon: string } {
  return CATEGORY_LABELS[category] ?? { label: category, icon: '⚙️' };
}
