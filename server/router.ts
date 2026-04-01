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
import { knowledgeRouter } from './routers/knowledge';
import { setupRouter } from './routers/setup';

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
  knowledge: knowledgeRouter,
  setup: setupRouter,
});

export type AppRouter = typeof appRouter;
