import type { LocationSeed } from './types';

export interface BuildingTemplate {
  id: string;
  name: string;
  type: string;
  category: 'core' | 'optional';
  minAgents: number;
  size: { w: number; h: number }; // tiles
  capacity: number;
  operatingHours: { open: number; close: number } | null;
  services: Array<{ needSatisfied: string; amount: number; cost: number; itemRequired: string | null }>;
  furniture: Array<{ offsetX: number; offsetY: number; key: string }>;
  description: string;
  zoneWeights: Record<string, number>;
  /** Enclosed buildings have walls + interior grids. Open-area buildings (farm, park, town_square) are walkable. */
  enclosed: boolean;
  /** Hex color for map preview rendering. */
  color: string;
}

import { TILE } from './config';

// ─── Core templates (always present, minAgents: 0) ────────────────────────────

const CORE: BuildingTemplate[] = [
  {
    id: 'shop',
    name: "Rosa's General Store",
    type: 'shop',
    category: 'core',
    minAgents: 0,
    size: { w: 5, h: 4 },
    capacity: 6,
    operatingHours: { open: 8, close: 18 },
    services: [
      { needSatisfied: 'hunger', amount: 15, cost: 6, itemRequired: null },
    ],
    furniture: [],
    description: "The town's main shop, well-stocked and tidy. Rosa runs a tight operation with Lucia's help.",
    zoneWeights: { commercial: 5, mainStreet: 4, civic: 1 },
    enclosed: true,
    color: '#5a5040',
  },
  {
    id: 'tavern',
    name: 'The Rusty Lantern',
    type: 'tavern',
    category: 'core',
    minAgents: 0,
    size: { w: 6, h: 4 },
    capacity: 10,
    operatingHours: { open: 16, close: 23 },
    services: [
      { needSatisfied: 'social', amount: 6, cost: 0, itemRequired: null },
      { needSatisfied: 'fun', amount: 8, cost: 4, itemRequired: null },
      { needSatisfied: 'hunger', amount: 8, cost: 5, itemRequired: null },
    ],
    furniture: [],
    description: 'A cozy tavern where locals gather every evening. Marco serves drinks behind a weathered oak bar while Diego plays in the corner.',
    zoneWeights: { commercial: 4, mainStreet: 5, civic: 1 },
    enclosed: true,
    color: '#7a4f35',
  },
  {
    id: 'clinic',
    name: "Dr. Petrov's Clinic",
    type: 'clinic',
    category: 'core',
    minAgents: 0,
    size: { w: 5, h: 4 },
    capacity: 4,
    operatingHours: { open: 8, close: 17 },
    services: [
      { needSatisfied: 'energy', amount: 5, cost: 12, itemRequired: null },
    ],
    furniture: [],
    description: 'A small but well-equipped medical clinic. Sofia and Omar keep the town healthy, one patient at a time.',
    zoneWeights: { commercial: 4, mainStreet: 3, civic: 3 },
    enclosed: true,
    color: '#d8e8e0',
  },
  {
    id: 'town_hall',
    name: 'Town Hall',
    type: 'town_hall',
    category: 'core',
    minAgents: 0,
    size: { w: 6, h: 5 },
    capacity: 8,
    operatingHours: { open: 9, close: 17 },
    services: [],
    furniture: [],
    description: 'The center of town governance, with a bell tower visible from anywhere. Mayor Park holds meetings here every morning.',
    zoneWeights: { civic: 5, commercial: 2, residential: 1 },
    enclosed: true,
    color: '#7a6a4a',
  },
  {
    id: 'town_square',
    name: 'Town Square',
    type: 'town_square',
    category: 'core',
    minAgents: 0,
    size: { w: 9, h: 8 },
    capacity: 20,
    operatingHours: null,
    services: [
      { needSatisfied: 'social', amount: 4, cost: 0, itemRequired: null },
      { needSatisfied: 'fun', amount: 3, cost: 0, itemRequired: null },
    ],
    furniture: [],
    description: 'The heart of Little Life, where everyone meets under the old oak tree. A fountain sits in the center.',
    zoneWeights: { civic: 4, commercial: 3, mainStreet: 3 },
    enclosed: false,
    color: '#8a7a5a',
  },
  {
    id: 'farm',
    name: 'Green Acres Farm',
    type: 'farm',
    category: 'core',
    minAgents: 0,
    size: { w: 10, h: 7 },
    capacity: 4,
    operatingHours: null,
    services: [],
    furniture: [],
    description: "The town's main source of food, with fields stretching to the river. Elena and James work the land from dawn to dusk.",
    zoneWeights: { residential: 4, civic: 3, commercial: 0 },
    enclosed: false,
    color: '#6b7c3a',
  },
  {
    id: 'park',
    name: 'Riverside Park',
    type: 'park',
    category: 'core',
    minAgents: 0,
    size: { w: 8, h: 6 },
    capacity: 12,
    operatingHours: null,
    services: [
      { needSatisfied: 'fun', amount: 5, cost: 0, itemRequired: null },
      { needSatisfied: 'comfort', amount: 3, cost: 0, itemRequired: null },
    ],
    furniture: [],
    description: 'A peaceful park by the river with old willow trees and a stone bridge.',
    zoneWeights: { civic: 4, residential: 3, commercial: 1 },
    enclosed: false,
    color: '#4a6b3a',
  },
];

// ─── Optional templates (unlocked at minAgents threshold) ─────────────────────

const OPTIONAL: BuildingTemplate[] = [
  {
    id: 'bakery',
    name: "Priya's Bakery",
    type: 'bakery',
    category: 'optional',
    minAgents: 6,
    size: { w: 5, h: 4 },
    capacity: 4,
    operatingHours: { open: 4, close: 14 },
    services: [
      { needSatisfied: 'hunger', amount: 12, cost: 5, itemRequired: null },
    ],
    furniture: [],
    description: 'A warm bakery that fills the street with the smell of fresh bread every morning. Priya is here before dawn.',
    zoneWeights: { commercial: 4, mainStreet: 5, residential: 2 },
    enclosed: true,
    color: '#6B5B4A',
  },
  {
    id: 'workshop',
    name: "Carlos' Workshop",
    type: 'workshop',
    category: 'optional',
    minAgents: 8,
    size: { w: 5, h: 4 },
    capacity: 3,
    operatingHours: { open: 7, close: 18 },
    services: [],
    furniture: [],
    description: 'A chaotic but functional workshop filled with tools, half-finished repairs, and sawdust. Carlos fixes everything here.',
    zoneWeights: { commercial: 4, residential: 3, civic: 1 },
    enclosed: true,
    color: '#4a4a42',
  },
  {
    id: 'prison',
    name: 'Town Jail',
    type: 'prison',
    category: 'optional',
    minAgents: 8,
    size: { w: 5, h: 4 },
    capacity: 4,
    operatingHours: null,
    services: [],
    furniture: [],
    description: 'A small stone jail behind the tavern. Rarely used, but the cells are always ready. The constable has the key.',
    zoneWeights: { civic: 4, commercial: 2, residential: 0 },
    enclosed: true,
    color: '#6A6A6A',
  },
  {
    id: 'pawnshop',
    name: 'The Pawnshop',
    type: 'pawnshop',
    category: 'optional',
    minAgents: 10,
    size: { w: 5, h: 4 },
    capacity: 4,
    operatingHours: { open: 10, close: 20 },
    services: [
      { needSatisfied: 'fun', amount: 3, cost: 2, itemRequired: null },
    ],
    furniture: [],
    description: "A dusty shop packed with odds and ends. You never know what you'll find — or who sold it.",
    zoneWeights: { commercial: 5, mainStreet: 3, civic: 0 },
    enclosed: true,
    color: '#5a4a3a',
  },
  {
    id: 'divebar',
    name: 'The Dive',
    type: 'divebar',
    category: 'optional',
    minAgents: 12,
    size: { w: 5, h: 4 },
    capacity: 12,
    operatingHours: { open: 18, close: 2 },
    services: [
      { needSatisfied: 'fun', amount: 6, cost: 3, itemRequired: null },
      { needSatisfied: 'social', amount: 4, cost: 0, itemRequired: null },
    ],
    furniture: [],
    description: 'A dimly lit bar at the edge of town. No frills, no judgment — just cheap drinks and loud music.',
    zoneWeights: { commercial: 5, mainStreet: 2, residential: 1 },
    enclosed: true,
    color: '#6a3a2a',
  },
];

// ─── Derived sets — single source of truth for type classification ───────────

/** Types that generate collision tiles (walls block pathfinding). Includes 'home'. */
export const ENCLOSED_BUILDING_TYPES: ReadonlySet<string> = new Set([
  'home',
  ...CORE.filter((t) => t.enclosed).map((t) => t.type),
  ...OPTIONAL.filter((t) => t.enclosed).map((t) => t.type),
]);

/** Types that are walkable open areas (farm, park, town_square) — no interior A*. */
export const OPEN_AREA_TYPES: ReadonlySet<string> = new Set(
  [...CORE, ...OPTIONAL].filter((t) => !t.enclosed).map((t) => t.type),
);

/** Type → hex color map for preview/rendering. */
export const BUILDING_COLORS: Readonly<Record<string, string>> = Object.fromEntries(
  [...CORE, ...OPTIONAL].map((t) => [t.type, t.color]),
);

// ─── Exports ──────────────────────────────────────────────────────────────────

export const BUILDING_TEMPLATES: BuildingTemplate[] = [...CORE, ...OPTIONAL];

export const CORE_TEMPLATES: BuildingTemplate[] = CORE;

/**
 * Returns all templates eligible for a simulation with `n` agents:
 * always includes all core templates, plus optional templates whose
 * minAgents threshold is <= n.
 */
export function getTemplatesForAgentCount(n: number): BuildingTemplate[] {
  return BUILDING_TEMPLATES.filter(
    (t) => t.category === 'core' || t.minAgents <= n,
  );
}

/**
 * Converts a placed BuildingTemplate at a given tile position into a
 * LocationSeed suitable for the world pipeline.
 */
export function templateToLocationSeed(
  template: BuildingTemplate,
  tileX: number,
  tileY: number,
): LocationSeed {
  const pxX = tileX * TILE;
  const pxY = tileY * TILE;
  const pxW = template.size.w * TILE;
  const pxH = template.size.h * TILE;
  return {
    name: template.name,
    type: template.type,
    position: { x: pxX, y: pxY, width: pxW, height: pxH },
    entry_point: { x: pxX + pxW / 2, y: pxY + pxH },
    capacity: template.capacity,
    current_occupants: [],
    operating_hours: template.operatingHours,
    services: template.services.map((s) => ({ ...s })),
    description: template.description,
    owner: null,
  };
}
