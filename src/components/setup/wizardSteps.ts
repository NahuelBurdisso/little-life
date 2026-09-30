/**
 * The setup wizard's steps, in the order the player walks them. Pure data so the
 * ordering rules are testable without mounting the wizard.
 *
 * Two dependencies fix the order:
 * - `preview` after `agents` and `relationships`: SimulationPreview is keyed on
 *   {scenario, agents}, so previewing before the cast is edited showed a drama that
 *   Start would then not build.
 * - `worldlayout` after `relationships`: the layout places households by the
 *   relationship graph, so laying it out earlier showed a town that Start would
 *   silently rearrange.
 */
export const STEPS = [
  { id: 'scenario', label: 'Scenario', icon: 'S' },
  { id: 'agents', label: 'Agents', icon: 'A' },
  { id: 'relationships', label: 'Relationships', icon: 'R' },
  { id: 'preview', label: 'Preview', icon: 'P' },
  { id: 'worldlayout', label: 'World Layout', icon: 'L' },
  { id: 'world', label: 'World', icon: 'W' },
  { id: 'rules', label: 'Rules', icon: 'S' },
] as const;

export type StepId = typeof STEPS[number]['id'];
