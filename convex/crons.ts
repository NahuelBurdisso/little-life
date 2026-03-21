import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();
crons.interval("game tick", { seconds: 1 }, internal.engine.tick.gameTick);
export default crons;
