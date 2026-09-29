/**
 * What the "?" help overlay lists. HOTKEYS mirrors src/hooks/useKeyboardControls.ts
 * (Space, 1-4, Tab, F) plus the two owned by App (Esc, ?); the speeds are the ones the hook
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
  { icon: '📰', how: 'Paper button (top right)', what: 'The Town Crier: one edition per day of what happened.' },
  { icon: '🎬', how: 'Toolbar: Auto-Cut', what: 'Let the camera follow the next dramatic moment.' },
  { icon: '🏘️', how: 'Toolbar: Meet the Town', what: 'Reopen the residents overview.' },
];
