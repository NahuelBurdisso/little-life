import { db } from '../server/db/index';
import { worldState, agents, needs, conversations, conversationQueue, conversationSchedulerState, agentStates, memories, relationships, relationshipEvents, facts, economyTransactions, activityLog, economy, templateUsage, worldEvents, locations } from '../server/db/schema';
import { eq } from 'drizzle-orm';
import fs from 'fs';
import { gameMinutes } from '../server/lib/gameClock';

const world = db.select().from(worldState).all()[0];
console.log("=== WORLD STATE ===");
console.log("Time:", JSON.stringify(world?.time));
console.log("Paused:", world?.is_paused);
console.log("Day phase:", world?.day_phase);

console.log("\n=== TABLE SIZES ===");
const tableSizes: Record<string, number> = {};
tableSizes["agents"] = db.select().from(agents).all().length;
tableSizes["needs"] = db.select().from(needs).all().length;
tableSizes["economy"] = db.select().from(economy).all().length;
tableSizes["conversations"] = db.select().from(conversations).all().length;
tableSizes["conversationQueue"] = db.select().from(conversationQueue).all().length;
tableSizes["schedulerState"] = db.select().from(conversationSchedulerState).all().length;
tableSizes["agentStates"] = db.select().from(agentStates).all().length;
tableSizes["memories"] = db.select().from(memories).all().length;
tableSizes["relationships"] = db.select().from(relationships).all().length;
tableSizes["relationshipEvents"] = db.select().from(relationshipEvents).all().length;
tableSizes["facts"] = db.select().from(facts).all().length;
tableSizes["economyTransactions"] = db.select().from(economyTransactions).all().length;
tableSizes["activityLog"] = db.select().from(activityLog).all().length;
tableSizes["templateUsage"] = db.select().from(templateUsage).all().length;
tableSizes["worldEvents"] = db.select().from(worldEvents).all().length;
tableSizes["locations"] = db.select().from(locations).all().length;

for (const [k, v] of Object.entries(tableSizes)) console.log(k + ":", v);

const activeConvos = db.select().from(conversations).where(eq(conversations.status, "active")).all();
const endedConvos = db.select().from(conversations).where(eq(conversations.status, "ended")).all();
console.log("  active convos:", activeConvos.length);
console.log("  ended convos:", endedConvos.length);

const unprocessedRE = db.select().from(relationshipEvents).where(eq(relationshipEvents.processed, false)).all().length;
console.log("  unprocessed rel events:", unprocessedRE);

const activeFacts = db.select().from(facts).where(eq(facts.is_active, true)).all().length;
console.log("  active facts:", activeFacts);

const scheduler = db.select().from(conversationSchedulerState).all()[0];
console.log("\n=== SCHEDULER ===");
console.log("Active LLM:", JSON.stringify(scheduler?.active_llm_conversations));
console.log("Stats:", JSON.stringify(scheduler?.stats));

console.log("\n=== AGENT STATUS ===");
const allAgents = db.select().from(agents).where(eq(agents.is_active, true)).all();
const totalTicks = (world?.time as any)?.totalTicks ?? 0;
// `action_started` is a game-minute stamp (see isActionComplete in decisions.ts).
const nowMinutes = world?.time ? gameMinutes(world.time as any) : 0;

for (const a of allAgents) {
  const n = db.select().from(needs).where(eq(needs.agent_id, a.id)).all()[0];
  const states = db.select().from(agentStates).where(eq(agentStates.agent_id, a.id)).all();
  const e = db.select().from(economy).where(eq(economy.agent_id, a.id)).all()[0];
  const action = a.current_action as any;
  const actionAge = nowMinutes - (a.action_started ?? 0);
  const pos = a.position as any;
  console.log(a.name,
    "| action:", JSON.stringify(action),
    "| age:", actionAge, "game min",
    "| pos:", pos?.x?.toFixed(0) + "," + pos?.y?.toFixed(0),
    "| dest:", a.current_destination ? "yes" : "no",
    "| loc:", a.current_location,
    "| mood:", n?.mood?.toFixed(1),
    "| energy:", n?.energy?.toFixed(1),
    "| hunger:", n?.hunger?.toFixed(1),
    "| social:", n?.social?.toFixed(1),
    "| money:", e?.money?.toFixed(0),
    "| states:", states.map(s => s.type).join(",") || "none",
    "| queueLen:", (a.action_queue as any[])?.length ?? 0,
    "| moodMods:", (n?.mood_modifiers as any[])?.length ?? 0
  );
}

console.log("\n=== POTENTIAL ISSUES ===");

// Stuck agents
for (const a of allAgents) {
  const actionAge = nowMinutes - (a.action_started ?? 0);
  const actionType = (a.current_action as any)?.type;
  if (actionAge > 500 && actionType !== "sleeping") {
    console.log("STUCK?", a.name, "action:", JSON.stringify(a.current_action), "for", actionAge, "game min");
  }
}

// Orphaned conversations
for (const c of activeConvos) {
  const parts = c.participants as number[];
  const talking = parts.filter(pid => {
    const agent = allAgents.find(a => a.id === pid);
    return (agent?.current_action as any)?.type === "talking";
  });
  if (talking.length === 0) {
    console.log("ORPHAN CONVO:", c.id, "participants:", parts, "none talking, age:", totalTicks - (c.started_at ?? 0), "ticks");
  }
}

// Critical needs
for (const a of allAgents) {
  const n = db.select().from(needs).where(eq(needs.agent_id, a.id)).all()[0];
  if (!n) continue;
  if (n.mood < 5) console.log("CRITICAL MOOD:", a.name, n.mood.toFixed(1));
  if (n.energy < 5) console.log("CRITICAL ENERGY:", a.name, n.energy.toFixed(1));
  if (n.hunger < 5) console.log("CRITICAL HUNGER:", a.name, n.hunger.toFixed(1));
}

if (unprocessedRE > 20) console.log("RELATIONSHIP EVENT PILE-UP:", unprocessedRE, "unprocessed events");

// Growth rates
const simDays = totalTicks / 1440 || 1;
console.log("Memory growth:", (tableSizes["memories"] / simDays).toFixed(1), "memories/sim-day");
console.log("ActivityLog growth:", (tableSizes["activityLog"] / simDays).toFixed(1), "entries/sim-day");
console.log("Transactions growth:", (tableSizes["economyTransactions"] / simDays).toFixed(1), "transactions/sim-day");
console.log("RelEvents growth:", (tableSizes["relationshipEvents"] / simDays).toFixed(1), "events/sim-day");
console.log("TemplateUsage growth:", (tableSizes["templateUsage"] / simDays).toFixed(1), "entries/sim-day");
console.log("Conversations growth:", (tableSizes["conversations"] / simDays).toFixed(1), "convos/sim-day");

// Economy health
const allEcon = db.select().from(economy).all();
const totalMoney = allEcon.reduce((s, e) => s + e.money, 0);
const broke = allEcon.filter(e => e.money < 0).length;
console.log("Total money in economy:", totalMoney.toFixed(0), "| Broke agents:", broke);
for (const e of allEcon) {
  const agent = allAgents.find(a => a.id === e.agent_id);
  console.log("  ", agent?.name ?? e.agent_id, ":", e.money.toFixed(0), "| salary:", e.salary.toFixed(0), "| expenses:", e.daily_expenses.toFixed(0));
}

// Mood modifier accumulation
for (const a of allAgents) {
  const n = db.select().from(needs).where(eq(needs.agent_id, a.id)).all()[0];
  const mods = n?.mood_modifiers as any[];
  if (mods && mods.length > 10) {
    console.log("MOOD MOD PILE-UP:", a.name, mods.length, "modifiers");
    const expired = mods.filter(m => m.expiresAt < totalTicks);
    if (expired.length > 0) console.log("  EXPIRED:", expired.length, "should have been cleaned");
  }
}

// Needs range check
for (const a of allAgents) {
  const n = db.select().from(needs).where(eq(needs.agent_id, a.id)).all()[0];
  if (!n) continue;
  const vals: Record<string, number> = { hunger: n.hunger, energy: n.energy, social: n.social, comfort: n.comfort, fun: n.fun, mood: n.mood, stress: n.stress };
  for (const [k, v] of Object.entries(vals)) {
    if (v < 0 || v > 100) console.log("OUT OF RANGE:", a.name, k, "=", v.toFixed(2));
  }
}

// Relationship range check
const allRels = db.select().from(relationships).all();
for (const r of allRels) {
  const vals: Record<string, number> = { friendship_ab: r.friendship_ab, friendship_ba: r.friendship_ba, romance_ab: r.romance_ab, romance_ba: r.romance_ba, trust_ab: r.trust_ab, trust_ba: r.trust_ba, familiarity: r.familiarity };
  for (const [k, v] of Object.entries(vals)) {
    if (v < -100 || v > 100) {
      const aa = allAgents.find(a => a.id === r.agent_a)?.name;
      const bb = allAgents.find(a => a.id === r.agent_b)?.name;
      console.log("REL OUT OF RANGE:", aa, "->", bb, k, "=", v.toFixed(2));
    }
  }
}

// DB file sizes
const dbSize = fs.statSync("./data/little-life.db").size;
const walSize = fs.existsSync("./data/little-life.db-wal") ? fs.statSync("./data/little-life.db-wal").size : 0;
console.log("\nDB size:", (dbSize / 1024 / 1024).toFixed(2), "MB");
console.log("WAL size:", (walSize / 1024 / 1024).toFixed(2), "MB");
console.log("DB size per sim-day:", (dbSize / 1024 / 1024 / simDays).toFixed(3), "MB/day");

// Projections
console.log("\n=== PROJECTIONS ===");
const memPerDay = tableSizes["memories"] / simDays;
const logPerDay = tableSizes["activityLog"] / simDays;
const txPerDay = tableSizes["economyTransactions"] / simDays;
const relEvPerDay = tableSizes["relationshipEvents"] / simDays;
const convoPerDay = tableSizes["conversations"] / simDays;
const tmplPerDay = tableSizes["templateUsage"] / simDays;

for (const target of [30, 90]) {
  console.log("At " + target + " sim-days:");
  console.log("  memories:", Math.round(memPerDay * target));
  console.log("  activityLog:", Math.round(logPerDay * target));
  console.log("  conversations:", Math.round(convoPerDay * target));
  console.log("  economyTransactions:", Math.round(txPerDay * target));
  console.log("  relationshipEvents:", Math.round(relEvPerDay * target));
  console.log("  templateUsage:", Math.round(tmplPerDay * target));
  console.log("  est DB size:", ((dbSize / 1024 / 1024 / simDays) * target).toFixed(1), "MB");
}

// Stale active conversations
const staleByTicks = activeConvos.filter(c => totalTicks - c.started_at > 200);
if (staleByTicks.length > 0) {
  console.log("\nSTALE ACTIVE CONVOS (>200 ticks old):", staleByTicks.length);
  for (const c of staleByTicks) {
    console.log("  id:", c.id, "age:", totalTicks - c.started_at, "ticks, participants:", c.participants, "msgs:", (c.messages as any[]).length);
  }
}

// Pending transitions
const pending = world?.pending_transitions as any[];
if (pending && pending.length > 0) console.log("PENDING TRANSITIONS:", pending.length, JSON.stringify(pending));

// Collision grid size
if (world?.collision_grid) {
  console.log("Collision grid string length:", world.collision_grid.length, "chars");
}

// Check memories with embeddings vs without
const allMems = db.select().from(memories).all();
const withEmb = allMems.filter(m => m.embedding !== null).length;
const avgEmbSize = allMems.filter(m => m.embedding !== null).reduce((s, m) => s + (m.embedding as Buffer).length, 0) / (withEmb || 1);
console.log("\nMemories with embeddings:", withEmb, "/", allMems.length);
console.log("Avg embedding size:", (avgEmbSize / 1024).toFixed(1), "KB");
console.log("Total embedding storage:", ((avgEmbSize * withEmb) / 1024 / 1024).toFixed(2), "MB");

// Check for conversation message bloat
const convoMsgCounts = db.select().from(conversations).all().map(c => (c.messages as any[]).length);
if (convoMsgCounts.length > 0) {
  const maxMsgs = Math.max(...convoMsgCounts);
  const avgMsgs = convoMsgCounts.reduce((s, n) => s + n, 0) / convoMsgCounts.length;
  console.log("\nConvo messages - max:", maxMsgs, "avg:", avgMsgs.toFixed(1));
}

// Check worldState size (collision_grid can be huge)
const worldRow = db.select().from(worldState).all()[0];
if (worldRow) {
  const gridLen = worldRow.collision_grid?.length ?? 0;
  console.log("Collision grid:", (gridLen / 1024).toFixed(1), "KB");
}

console.log("\nDone.");
