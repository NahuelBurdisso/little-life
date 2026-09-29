import { router } from './trpc';
import { worldRouter } from './routers/world';
import { agentsRouter } from './routers/agents';
import { conversationsRouter } from './routers/conversations';
import { relationshipsRouter } from './routers/relationships';
import { economyRouter } from './routers/economy';
import { locationsRouter } from './routers/locations';
import { activityRouter } from './routers/activity';
import { chronicleRouter } from './routers/chronicle';
import { nudgeRouter } from './routers/nudge';
import { knowledgeRouter } from './routers/knowledge';
import { setupRouter } from './routers/setup';
import { autoplayRouter } from './routers/autoplay';
import { gazetteRouter } from './routers/gazette';
import { savesRouter } from './routers/saves';

export const appRouter = router({
  world: worldRouter,
  agents: agentsRouter,
  conversations: conversationsRouter,
  relationships: relationshipsRouter,
  economy: economyRouter,
  locations: locationsRouter,
  activity: activityRouter,
  chronicle: chronicleRouter,
  nudge: nudgeRouter,
  knowledge: knowledgeRouter,
  setup: setupRouter,
  autoplay: autoplayRouter,
  gazette: gazetteRouter,
  saves: savesRouter,
});

export type AppRouter = typeof appRouter;
