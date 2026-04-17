import type { Stage, RoadsOutput, Zone } from '../types';

export interface RoadPositions {
  mainStreetY: number;
  crossPathY: number;
  vertWestX: number;
  vertEastX: number;
}

export function computeRoadPositions(width: number, height: number): RoadPositions {
  return {
    mainStreetY: Math.floor(height * 0.33),
    crossPathY: Math.floor(height * 0.70),
    vertWestX: Math.floor(width * 0.27),
    vertEastX: Math.floor(width * 0.60),
  };
}

export function deriveZones(r: RoadPositions, width: number, height: number): Zone[] {
  const cols = [
    { x1: 1, x2: r.vertWestX - 1 },
    { x1: r.vertWestX + 2, x2: r.vertEastX - 1 },
    { x1: r.vertEastX + 2, x2: width - 2 },
  ];
  const rows = [
    { y1: 1, y2: r.mainStreetY - 1 },
    { y1: r.mainStreetY + 2, y2: r.crossPathY - 1 },
    { y1: r.crossPathY + 2, y2: height - 2 },
  ];

  const ZONE_IDS = [
    ['sw', 'sc', 'se'],   // row 0 (smallest y)
    ['wm', 'cm', 'em'],   // row 1
    ['nw', 'nc', 'ne'],   // row 2 (largest y)
  ];

  // Affinities from spec §4.3
  const AFFINITIES: Record<string, Record<string, number>> = {
    sw: { residential: 5, commercial: 2, mainStreet: 1, civic: 0 },
    sc: { residential: 4, commercial: 3, mainStreet: 2, civic: 0 },
    se: { commercial: 4, mainStreet: 4, residential: 2, civic: 0 },
    wm: { residential: 4, commercial: 3, mainStreet: 2, civic: 0 },
    cm: { commercial: 4, civic: 3, mainStreet: 3, residential: 0 },
    em: { commercial: 5, mainStreet: 3, residential: 1, civic: 0 },
    nw: { civic: 4, residential: 3, commercial: 1, mainStreet: 0 },
    nc: { civic: 5, commercial: 2, residential: 1, mainStreet: 0 },
    ne: { civic: 3, residential: 4, commercial: 1, mainStreet: 0 },
  };

  const zones: Zone[] = [];
  for (let row = 0; row < 3; row++) {
    for (let col = 0; col < 3; col++) {
      const id = ZONE_IDS[row][col];
      zones.push({
        id,
        bounds: { x1: cols[col].x1, y1: rows[row].y1, x2: cols[col].x2, y2: rows[row].y2 },
        affinity: AFFINITIES[id],
      });
    }
  }
  return zones;
}

function generateRoadTiles(r: RoadPositions, width: number, height: number): Array<{ x: number; y: number }> {
  const tiles: Array<{ x: number; y: number }> = [];
  // Horizontal: main street (2 tiles wide)
  for (let x = 1; x < width - 1; x++) {
    tiles.push({ x, y: r.mainStreetY });
    tiles.push({ x, y: r.mainStreetY + 1 });
  }
  // Horizontal: cross path (2 tiles wide)
  for (let x = 1; x < width - 1; x++) {
    tiles.push({ x, y: r.crossPathY });
    tiles.push({ x, y: r.crossPathY + 1 });
  }
  // Vertical: west path (2 tiles wide)
  for (let y = 1; y < height - 1; y++) {
    tiles.push({ x: r.vertWestX, y });
    tiles.push({ x: r.vertWestX + 1, y });
  }
  // Vertical: east path (2 tiles wide)
  for (let y = 1; y < height - 1; y++) {
    tiles.push({ x: r.vertEastX, y });
    tiles.push({ x: r.vertEastX + 1, y });
  }
  return tiles;
}

export const roadsStage: Stage<{ roads: RoadsOutput }> = {
  name: 'roads',
  dependsOn: ['dimensions'],
  run(ctx) {
    if (!ctx.dimensions) throw new Error('roads: dimensions not populated');
    const { width, height } = ctx.dimensions;
    const positions = computeRoadPositions(width, height);
    return {
      roads: {
        tiles: generateRoadTiles(positions, width, height),
        zones: deriveZones(positions, width, height),
      },
    };
  },
};
