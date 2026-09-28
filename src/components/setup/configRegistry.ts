/**
 * Simulation Config Registry
 *
 * Single source of truth for all configurable simulation parameters.
 * To add a new setting: add one entry here.
 * - UI auto-generates the control
 * - Server accepts it without schema changes
 * - Simulation reads it with fallback to default
 */

export interface ConfigParam {
  key: string;
  label: string;
  description: string;
  type: 'toggle' | 'slider' | 'select' | 'text';
  default: boolean | number | string;
  category: 'simulation' | 'llm' | 'economy';
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
    type: 'toggle', default: true, category: 'simulation',
  },
  {
    key: 'sicknessRate', label: 'Sickness Rate',
    description: 'How often agents get sick from the environment',
    type: 'select', default: 'low', category: 'simulation',
    options: ['off', 'low', 'medium', 'high'],
  },
  {
    key: 'contagionRate', label: 'Contagion Rate',
    description: 'How easily sickness spreads between agents',
    type: 'select', default: 'low', category: 'simulation',
    options: ['off', 'low', 'medium', 'high'],
  },
  {
    key: 'dramaIntensity', label: 'Drama Intensity',
    description: 'Controls frequency of dark dynamics (theft, jealousy, conflict)',
    type: 'select', default: 'medium', category: 'simulation',
    options: ['low', 'medium', 'high', 'chaos'],
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

  // === LLM / AI ===
  {
    key: 'llmModel', label: 'LLM Model',
    description: 'Ollama model name for agent conversations',
    type: 'text', default: 'huihui_ai/gemma-4-abliterated:e4b', category: 'llm',
  },
  {
    key: 'llmTemperature', label: 'Temperature',
    description: 'Higher = more creative, lower = more focused',
    type: 'slider', default: 0.8, category: 'llm',
    min: 0.1, max: 2.0, step: 0.1,
  },
  {
    key: 'llmMaxTokens', label: 'Max Tokens',
    description: 'Maximum response length per conversation turn',
    type: 'slider', default: 250, category: 'llm',
    min: 100, max: 500, step: 50,
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
  llm: { label: 'LLM / AI', icon: '🤖' },
};

export function getCategoryLabel(category: string): { label: string; icon: string } {
  return CATEGORY_LABELS[category] ?? { label: category, icon: '⚙️' };
}
