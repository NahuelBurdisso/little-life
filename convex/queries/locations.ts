import { query } from "../_generated/server";
import { v } from "convex/values";

export const getLocations = query({
  args: {},
  handler: async (ctx) => {
    return await ctx.db.query("locations").collect();
  },
});

export const getLocationOccupants = query({
  args: { locationId: v.id("locations") },
  handler: async (ctx, args) => {
    const loc = await ctx.db.get(args.locationId);
    if (!loc) return null;
    const occupants = await Promise.all(
      loc.currentOccupants.map((id) => ctx.db.get(id))
    );
    return {
      location: loc,
      occupants: occupants.filter(Boolean),
    };
  },
});
