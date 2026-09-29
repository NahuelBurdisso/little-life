// Throwaway visual harness for the place-life effects: real PixiJS, real TilemapRenderer and
// BuildingRenderer, a hand-made town and fake agents. No server. Serve with `npx vite` and open
// /docs/scratch/place-life-harness.html?season=autumn&phase=night&weather=windy&zoom=2
import * as PIXI from "pixi.js";
import { TilemapRenderer } from "../../src/components/canvas/TilemapRenderer";
import { BuildingRenderer } from "../../src/components/canvas/BuildingRenderer";
import { createPlaceLifeSystem } from "../../src/components/canvas/systems/placeLife/PlaceLifeSystem";
import { seasonDayOf } from "../../src/components/canvas/crops";

const q = new URLSearchParams(location.search);
const season = q.get("season") ?? "summer";
const seasonDay = Number(q.get("day") ?? 14);
const phase = q.get("phase") ?? "morning";
const weather = q.get("weather") ?? "sunny";
const zoom = Number(q.get("zoom") ?? 2);
const hour = Number(q.get("hour") ?? 10);
const cx = Number(q.get("cx") ?? 0), cy = Number(q.get("cy") ?? 0);

const T = 32;
const b = (id: number, type: string, tx: number, ty: number, w: number, h: number, doorCol: number, extra: any = {}) => ({
  id, type, name: type, position: { x: tx * T, y: ty * T, width: w * T, height: h * T },
  entry_point: { x: tx * T + doorCol * T + 16, y: (ty + h) * T }, current_occupants: [], ...extra,
});
const locations: any[] = [
  b(1, "workshop", 3, 3, 5, 4, 2),
  b(2, "bakery", 11, 3, 5, 4, 2, { operating_hours: { open: 6, close: 14 } }),
  b(3, "tavern", 19, 3, 6, 5, 3),
  b(4, "clinic", 3, 11, 5, 4, 2),
  b(5, "town_hall", 11, 11, 6, 5, 3),
  b(6, "prison", 19, 11, 5, 4, 2),
  b(7, "shop", 27, 3, 5, 4, 2, { operating_hours: { open: 8, close: 18 } }),
  b(8, "home", 27, 11, 3, 3, 1),
  b(9, "home", 32, 11, 3, 3, 1),
  b(10, "farm", 3, 20, 10, 7, 4),
  b(11, "farmyard", 15, 21, 3, 3, 1),
  b(12, "pawnshop", 27, 18, 5, 4, 2),
  b(13, "divebar", 20, 20, 5, 4, 2),
];
const P = (locId: number, dx: number, dy: number) => {
  const l = locations.find((x) => x.id === locId)!;
  return { x: l.position.x + dx, y: l.position.y + dy };
};
const agents: any[] = [
  { id: 1, current_location: 1, workplace: 1, current_action: { type: "working" }, position: P(1, 80, 80), activeStates: [] },
  { id: 2, current_location: 2, workplace: 2, current_action: { type: "working" }, position: P(2, 80, 48), activeStates: [] },
  ...[3, 4, 5, 6].map((id) => ({ id, current_location: 3, current_action: { type: "idle" }, position: P(3, 60 + id * 8, 100), activeStates: [] })),
  { id: 7, current_location: 3, current_action: { type: "idle", zoneActivity: "perform" }, position: P(3, 112, 48), activeStates: [] },
  { id: 8, current_location: 4, workplace: 4, current_action: { type: "working" }, position: P(4, 80, 60), activeStates: [] },
  { id: 9, current_location: 4, current_action: { type: "idle" }, position: P(4, 100, 90), activeStates: [{ type: "sick" }] },
  ...[10, 11, 12].map((id) => ({ id, current_location: 5, current_action: { type: "idle" }, position: P(5, 60 + id * 6, 90), activeStates: [] })),
  { id: 13, current_location: 6, current_action: { type: "idle" }, position: P(6, 60, 60), activeStates: [{ type: "arrested" }] },
  { id: 14, current_location: 10, current_action: { type: "working" }, position: P(10, 60, 40), activeStates: [] },
  { id: 15, current_location: 8, current_action: { type: "eating" }, position: P(8, 40, 40), activeStates: [] },
  { id: 16, current_location: 9, current_action: { type: "idle" }, position: P(9, 40, 40), activeStates: [] },
  { id: 17, current_location: 7, workplace: 7, current_action: { type: "working" }, position: P(7, 80, 60), activeStates: [] },
  ...[18, 19, 20].map((id) => ({ id, current_location: 13, current_action: { type: "idle" }, position: P(13, 40 + id, 60), activeStates: [] })),
];
const roads: any[] = [];
for (let x = 0; x < 42; x++) roads.push({ x, y: 9 }, { x, y: 17 });
const world: any = {
  day_phase: phase, weather, time: { hour, season, seasonDay, day: seasonDay },
  map_width: 42, map_height: 30, terrain_tiles: [], road_tiles: roads,
};

const app = new PIXI.Application();
await app.init({ width: 1500, height: 940, background: 0x4a7a3a, antialias: false });
document.getElementById("root")!.appendChild(app.canvas);
const wc = new PIXI.Container();
app.stage.addChild(wc);
const tilemap = new TilemapRenderer(app);
wc.addChild(tilemap.container);
tilemap.resize(world.map_width, world.map_height);
tilemap.setOpenAreaZones(locations);
tilemap.setCropSeason(season, seasonDayOf(world.time));
const buildings = new BuildingRenderer(wc);
buildings.init(locations as any);
const occ = new Map<number, number | null>();
for (const a of agents) occ.set(a.id, a.current_location);
buildings.update(occ);

const ground = new PIXI.Container();
wc.addChild(ground);
// stand-in agents (dots) so the layering under/over them is visible
const dots = new PIXI.Container();
wc.addChild(dots);
const positions: Record<string, { x: number; y: number }> = {};
for (const a of agents) {
  positions[String(a.id)] = { x: a.position.x, y: a.position.y };
  const g = new PIXI.Graphics().circle(0, -6, 5).fill(0xe8d5a3).stroke({ width: 1, color: 0x1a1510 });
  g.position.set(a.position.x, a.position.y);
  dots.addChild(g);
}
const over = new PIXI.Container();
wc.addChild(over);
const sys = createPlaceLifeSystem(
  { ground, overAgents: over },
  { sprites: { getSprite: (id: string) => (positions[id] ? { container: positions[id] } : undefined) } as any, bubbles: {} as any },
);
const data: any = { agents, world, events: [], locations, conversations: [], relationships: [], activity: [] };
wc.scale.set(zoom);
wc.position.set(-cx * zoom, -cy * zoom);
const view: any = { x: cx, y: cy, w: 1500 / zoom, h: 940 / zoom, scale: zoom };
setTimeout(() => sys.onData!(data), 400);
app.ticker.add((t) => {
  sys.update({ dt: t.deltaTime, seconds: t.deltaTime / 60, now: performance.now(), view, data });
});
(window as any).h = { data, sys, app, wc, tilemap, view, buildings, agents };
