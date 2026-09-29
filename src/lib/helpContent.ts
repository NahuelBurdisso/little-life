/**
 * What the "?" help overlay lists. HOTKEYS mirrors src/hooks/useKeyboardControls.ts
 * (Space, 1-4, Tab, F, C, J) plus the two owned by App (Esc, ?) and the Journal's own tab keys
 * (← / →, 1-6 while it is open, src/components/ui/Journal.tsx); the speeds are the ones the hook
 * sends, so a change there should show up here too.
 */
export interface HelpEntry {
  keys: string[];
  what: string;
}

export const HOTKEYS: HelpEntry[] = [
  { keys: ['Space'], what: 'Pause or resume the town' },
  { keys: ['1'], what: 'Speed 0.5×' },
  { keys: ['2'], what: 'Speed 1×' },
  { keys: ['3'], what: 'Speed 2×' },
  { keys: ['4'], what: 'Speed 4×' },
  { keys: ['Tab', 'Shift+Tab'], what: 'Select the next / previous resident (favourites first)' },
  { keys: ['F'], what: 'Follow the selected resident with the camera' },
  { keys: ['C'], what: 'Show or hide the Director\'s captions (who is saying what)' },
  { keys: ['J'], what: 'Open or close the Journal: the paper, alerts and stories' },
  { keys: ['←', '→'], what: 'Switch Journal tabs (1–6 also pick one while it is open)' },
  { keys: ['Esc'], what: 'Close the topmost panel, menu or overlay' },
  { keys: ['?'], what: 'Show or hide this help' },
];

export interface VerbEntry {
  icon: string;
  how: string;
  what: string;
}

/** The player's verbs, in the order a new player needs them. */
export const VERBS: VerbEntry[] = [
  { icon: '👆', how: 'Click a resident', what: 'Inspect them: needs, thoughts, plans, memories, ties.' },
  {
    icon: '🖱️',
    how: 'Right-click a resident',
    what: 'Meddle: suggest a chat or a destination, give money, pair them up, slip a secret, stage a confrontation.',
  },
  { icon: '🏠', how: 'Click a building', what: 'See who is inside and what is going on there.' },
  { icon: '✋', how: 'Drag and scroll the map', what: 'Pan and zoom.' },
  { icon: '⚡', how: 'Events button (top right)', what: 'Trigger a town event or set the weather.' },
  {
    icon: '📖',
    how: 'Journal button (top right) or J',
    what: 'The Town Crier, your alerts, what is brewing, the running stories, the timeline and every conversation.',
  },
  {
    icon: '🎬',
    how: 'Toolbar: Director',
    what: 'Let the camera pick the best scene, hold it, and caption what is said. Moving the map yourself pauses it for 20 seconds.',
  },
  { icon: '🏘️', how: 'Toolbar: Meet the Town', what: 'Reopen the residents overview.' },
];
