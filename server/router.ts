import { router } from './trpc';
import { worldRouter } from './routers/world';
import { agentsRouter } from './routers/agents';
import { conversationsRouter } from './routers/conversations';
import { memoriesRouter } from './routers/memories';
import { relationshipsRouter } from './routers/relationships';
import { economyRouter } from './routers/economy';
import { locationsRouter } from './routers/locations';
import { activityRouter } from './routers/activity';
import { nudgeRouter } from './routers/nudge';
import { factsRouter } from './routers/facts';

export const appRouter = router({
  world: worldRouter,
  agents: agentsRouter,
  conversations: conversationsRouter,
  memories: memoriesRouter,
  relationships: relationshipsRouter,
  economy: economyRouter,
  locations: locationsRouter,
  activity: activityRouter,
  nudge: nudgeRouter,
  facts: factsRouter,
});

export type AppRouter = typeof appRouter;
