/**
 * Offline check for the spotlight budget (server/lib/conversationTier.ts):
 * of the conversations on the player's screen, how many get a live LLM chat
 * instead of a canned template — before (the old tier logic: nothing watched,
 * no pressure signals) and after (chooseTier with the spotlight, backlog and
 * population).
 *
 *   npx tsx scripts/spotlight-sim.ts [--residents 32] [--speed 1] [--days 3] [--seed 1]
 *
 * A synthetic waking day (07:00–23:00) of a town, one step per game minute,
 * with the conversation scheduler reduced to what matters here
 * (engine/systems/conversations.ts): entries served by priority, at most
 * MAX_CONCURRENT_LLM live LLM chats, a template-tier entry runs at once, an
 * LLM entry waits up to QUEUE_MAX_WAIT_GAME_MINUTES for a slot and then ages
 * out into a template chat. An LLM chat lasts its turns × the measured turn
 * latency × tick_speed game minutes (planConversation). The spotlight is what
 * useSpotlight would send: the selected resident, the director's pair, the
 * hottest brewing residents, a few more in the camera view and two favourites,
 * the camera moving on every ~20 real seconds.
 *
 * Not a model of the whole sim — needs, plans and places are replaced by a
 * per-minute chance to seek someone — but it drives the real chooseTier with
 * the real constants, and both runs see the same seeded town and demand.
 */
import { chooseTier, conversationBacklog, type ConversationTier, type TierContext } from '../server/lib/conversationTier';
import { CONFIG } from '../server/lib/constants';

export interface SimOptions {
  residents: number;
  /** tick_speed: game minutes per real second. */
  speed: number;
  days: number;
  seed: number;
  /** Median LLM turn in ms (Gemma 4 26B with 4 slots measures ~1.3–1.8 s). */
  turnMs: number;
  /** Chance per idle resident per game minute to seek someone out. */
  seekPerMinute: number;
}

export interface SimResult {
  mode: 'before' | 'after';
  conversations: number;
  onScreen: number;
  onScreenLLM: number;
  offScreen: number;
  offScreenLLM: number;
  dramaticOffScreen: number;
  dramaticOffScreenLLM: number;
  llmTotal: number;
}

export const DEFAULT_SIM: SimOptions = { residents: 32, speed: 1, days: 3, seed: 1, turnMs: 1800, seekPerMinute: 0.012 };

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Entry {
  a: number;
  b: number;
  tier: ConversationTier;
  priority: number;
  deadline: number;
  watched: boolean;
  dramatic: boolean;
}

export function simulate(mode: 'before' | 'after', opts: SimOptions = DEFAULT_SIM): SimResult {
  const rand = mulberry32(opts.seed);
  const n = opts.residents;
  const C = CONFIG.CONVERSATIONS;

  // The town: pair ties and per-resident mood/state, drawn once from the seed.
  const friendship: number[][] = [];
  const romance: number[][] = [];
  for (let i = 0; i < n; i++) {
    friendship.push([]);
    romance.push([]);
    for (let j = 0; j < n; j++) {
      if (j < i) {
        friendship[i].push(friendship[j][i]);
        romance[i].push(romance[j][i]);
      } else {
        // Most pairs are acquaintances; a few friends, a few enemies, a few crushes.
        const r = rand();
        friendship[i].push(r < 0.08 ? -30 - rand() * 30 : r < 0.3 ? 45 + rand() * 40 : rand() * 40);
        romance[i].push(rand() < 0.06 ? 15 + rand() * 40 : 0);
      }
    }
  }

  const res: SimResult = {
    mode, conversations: 0, onScreen: 0, onScreenLLM: 0, offScreen: 0, offScreenLLM: 0,
    dramaticOffScreen: 0, dramaticOffScreenLLM: 0, llmTotal: 0,
  };
  const busyUntil = new Array<number>(n).fill(0);
  const activeLLMEnds: number[] = [];
  const queue: Entry[] = [];
  const turnGameMin = (opts.turnMs / CONFIG.TICK_INTERVAL_MS) * opts.speed;

  let watched = new Set<number>();
  let nextCameraMove = 0;
  const favorites = [0, 1];
  const mood = new Array<number>(n).fill(60);
  const dramaticState = new Array<boolean>(n).fill(false);

  const record = (e: Entry, llm: boolean) => {
    res.conversations++;
    if (llm) res.llmTotal++;
    if (e.watched) {
      res.onScreen++;
      if (llm) res.onScreenLLM++;
    } else {
      res.offScreen++;
      if (llm) res.offScreenLLM++;
      if (e.dramatic) {
        res.dramaticOffScreen++;
        if (llm) res.dramaticOffScreenLLM++;
      }
    }
  };

  for (let day = 0; day < opts.days; day++) {
    // Moods and dramatic states drift day to day.
    for (let i = 0; i < n; i++) {
      mood[i] = Math.max(5, Math.min(95, 60 + (rand() - 0.5) * 60));
      dramaticState[i] = rand() < 0.12;
    }
    const brewing = [...Array(n).keys()].filter((i) => dramaticState[i]).slice(0, 3);

    for (let minute = 7 * 60; minute < 23 * 60; minute++) {
      const now = day * 1440 + minute;

      // The camera: a new selected resident and scene every ~20 real seconds.
      if (now >= nextCameraMove) {
        const selected = Math.floor(rand() * n);
        const view = new Set<number>([selected, ...favorites, ...brewing]);
        while (view.size < 3 + favorites.length + brewing.length + 4) view.add(Math.floor(rand() * n));
        watched = view;
        nextCameraMove = now + Math.max(1, Math.round(20 * opts.speed));
      }

      // Finished LLM chats free their slot.
      for (let k = activeLLMEnds.length - 1; k >= 0; k--) if (activeLLMEnds[k] <= now) activeLLMEnds.splice(k, 1);

      // Demand: idle residents seek someone idle.
      const backlog = conversationBacklog({
        semaphoreWaiting: 0,
        activeLLMConversations: activeLLMEnds.length,
        maxConcurrentLLM: C.MAX_CONCURRENT_LLM,
        queuedLLMEntries: queue.filter((q) => q.tier !== 'template').length,
      });
      for (let a = 0; a < n; a++) {
        // Every draw happens whatever the outcome, so both modes consume the
        // same random stream and see the same town and the same demand.
        const [seek, pick, src, soc, top, first, gossip, pri] = Array.from({ length: 8 }, rand);
        if (busyUntil[a] > now || seek >= opts.seekPerMinute) continue;
        if (queue.some((q) => q.a === a || q.b === a)) continue;
        let b = Math.floor(pick * (n - 1));
        if (b >= a) b++;
        if (busyUntil[b] > now) continue;
        const isWatched = watched.has(a) || watched.has(b);
        const after = mode === 'after';
        const ctx: TierContext = {
          source: src < 0.75 ? 'social' : 'encounter',
          friendship: friendship[a][b],
          romance: romance[a][b],
          mood: mood[a],
          social: 20 + soc * 70,
          dramaticState: dramaticState[a] || dramaticState[b],
          topic: top < 0.08 ? 'gossip about someone' : null,
          firstMeeting: first < 0.03,
          hasGossip: gossip < 0.1,
          // Before: what decisions.ts did — no spotlight, no pressure signals.
          watched: after && isWatched,
          backlog: after ? backlog : 0,
          population: after ? n : 0,
          latencyMs: after ? opts.turnMs : null,
          basePriority: Math.round(pri * 120),
          smallTalkTier: 'llm_standard',
        };
        const choice = chooseTier(ctx);
        queue.push({
          a, b, tier: choice.tier, priority: choice.priority,
          deadline: now + choice.maxWaitGameMin,
          watched: isWatched,
          dramatic: choice.signal === 'dramatic',
        });
      }

      // The scheduler pass: highest priority first.
      queue.sort((x, y) => y.priority - x.priority);
      for (let k = 0; k < queue.length; k++) {
        const e = queue[k];
        const free = busyUntil[e.a] <= now && busyUntil[e.b] <= now;
        if (now > e.deadline || e.tier === 'template') {
          // Timed out, or a template chat: a brief canned exchange if both are free.
          if (!free && e.tier === 'template' && now <= e.deadline) continue;
          queue.splice(k--, 1);
          if (!free) continue; // dropped
          busyUntil[e.a] = busyUntil[e.b] = now + 2;
          record(e, false);
          continue;
        }
        if (!free || activeLLMEnds.length >= C.MAX_CONCURRENT_LLM) continue;
        const maxTurns = e.tier === 'llm_deep' ? C.MAX_TURNS_DEEP : C.MAX_TURNS_STANDARD;
        const turns = Math.min(maxTurns, Math.floor((maxTurns * C.GAME_MINUTES_PER_TURN) / Math.max(turnGameMin, 0.001)));
        const end = now + Math.max(1, Math.ceil(turns * turnGameMin));
        activeLLMEnds.push(end);
        busyUntil[e.a] = busyUntil[e.b] = end;
        queue.splice(k--, 1);
        record(e, true);
      }
    }
    queue.length = 0;
  }
  return res;
}

function pct(a: number, b: number): string {
  return b === 0 ? '—' : `${((100 * a) / b).toFixed(1)}%`;
}

export function formatRow(r: SimResult): string {
  return [
    r.mode.padEnd(6),
    `on-screen LLM ${pct(r.onScreenLLM, r.onScreen).padStart(6)} (${r.onScreenLLM}/${r.onScreen})`,
    `off-screen LLM ${pct(r.offScreenLLM, r.offScreen).padStart(6)} (${r.offScreenLLM}/${r.offScreen})`,
    `off-screen drama LLM ${pct(r.dramaticOffScreenLLM, r.dramaticOffScreen).padStart(6)}`,
    `LLM chats ${r.llmTotal}/${r.conversations}`,
  ].join(' | ');
}

function arg(name: string, fallback: number): number {
  const i = process.argv.indexOf(`--${name}`);
  const v = i >= 0 ? Number(process.argv[i + 1]) : NaN;
  return Number.isFinite(v) ? v : fallback;
}

if (process.argv[1]?.replace(/\\/g, '/').endsWith('scripts/spotlight-sim.ts')) {
  const base: SimOptions = {
    ...DEFAULT_SIM,
    residents: arg('residents', DEFAULT_SIM.residents),
    days: arg('days', DEFAULT_SIM.days),
    seed: arg('seed', DEFAULT_SIM.seed),
    turnMs: arg('turn-ms', DEFAULT_SIM.turnMs),
    seekPerMinute: arg('seek', DEFAULT_SIM.seekPerMinute),
  };
  const speeds = process.argv.includes('--speed') ? [arg('speed', 1)] : [1, 2, 4];
  for (const speed of speeds) {
    const opts = { ...base, speed };
    console.log(`\n${opts.residents} residents, ${speed}x, ${opts.days} days, turn ${opts.turnMs} ms, seed ${opts.seed}`);
    console.log(formatRow(simulate('before', opts)));
    console.log(formatRow(simulate('after', opts)));
  }
}
