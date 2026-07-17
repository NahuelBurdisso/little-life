/**
 * furnitureCoherence.test.ts
 * Tier 2 coherence invariant: every furniture label appearing in INTERIOR_ZONES
 * must have an entry in both FURNITURE_SPRITE (renderer) and FURNITURE_URLS
 * (texture registry) — all three or none.
 *
 * This test is intentionally import-side-effect-free from PixiJS. It reads the
 * maps as plain data via static imports; PIXI is never initialised.
 */

import { describe, it, expect } from 'vitest';
import { INTERIOR_ZONES } from '../data/interiors';

// We import the two maps that own the label→key and key→url contracts.
// Both are now exported for testability.
import { FURNITURE_SPRITE } from '../../src/components/canvas/BuildingRenderer';
import { FURNITURE_URLS } from '../../src/components/canvas/textures';

describe('furniture registry coherence', () => {
  // Collect every unique furniture label used across all interior zones.
  const labelsInZones = new Set<string>();
  for (const zones of Object.values(INTERIOR_ZONES)) {
    for (const zone of zones) {
      if (zone.furniture?.label) {
        labelsInZones.add(zone.furniture.label);
      }
    }
  }

  it('collects at least 18 unique furniture labels from INTERIOR_ZONES', () => {
    expect(labelsInZones.size).toBeGreaterThanOrEqual(18);
  });

  it('every label in INTERIOR_ZONES has an entry in FURNITURE_SPRITE', () => {
    for (const label of labelsInZones) {
      expect(
        FURNITURE_SPRITE[label],
        `Label "${label}" found in INTERIOR_ZONES but missing from FURNITURE_SPRITE`,
      ).toBeDefined();
    }
  });

  it('every key in FURNITURE_SPRITE exists in FURNITURE_URLS', () => {
    for (const [label, key] of Object.entries(FURNITURE_SPRITE)) {
      expect(
        FURNITURE_URLS[key],
        `FURNITURE_SPRITE["${label}"] → key "${key}" has no entry in FURNITURE_URLS`,
      ).toBeDefined();
    }
  });

  it('every FURNITURE_URLS key is referenced by at least one FURNITURE_SPRITE entry', () => {
    const usedKeys = new Set(Object.values(FURNITURE_SPRITE));
    for (const key of Object.keys(FURNITURE_URLS)) {
      expect(
        usedKeys.has(key),
        `FURNITURE_URLS key "${key}" is never referenced by FURNITURE_SPRITE — orphan entry`,
      ).toBe(true);
    }
  });
});
