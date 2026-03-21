/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as actions_generateEmbedding from "../actions/generateEmbedding.js";
import type * as actions_generateReflection from "../actions/generateReflection.js";
import type * as actions_generateResponse from "../actions/generateResponse.js";
import type * as ai_memories from "../ai/memories.js";
import type * as ai_ollama from "../ai/ollama.js";
import type * as ai_prompts from "../ai/prompts.js";
import type * as ai_sentiment from "../ai/sentiment.js";
import type * as ai_templates from "../ai/templates.js";
import type * as ai_topics from "../ai/topics.js";
import type * as crons from "../crons.js";
import type * as engine_constants from "../engine/constants.js";
import type * as engine_tick from "../engine/tick.js";
import type * as helpers_actionHelpers from "../helpers/actionHelpers.js";
import type * as init_agents from "../init/agents.js";
import type * as init_initialize from "../init/initialize.js";
import type * as init_loadMap from "../init/loadMap.js";
import type * as init_memories from "../init/memories.js";
import type * as init_relationships from "../init/relationships.js";
import type * as init_reset from "../init/reset.js";
import type * as lib_pathfinding from "../lib/pathfinding.js";
import type * as lib_prices from "../lib/prices.js";
import type * as lib_types from "../lib/types.js";
import type * as lib_utils from "../lib/utils.js";
import type * as lib_validators from "../lib/validators.js";
import type * as nudge from "../nudge.js";
import type * as queries_activityLog from "../queries/activityLog.js";
import type * as queries_agents from "../queries/agents.js";
import type * as queries_conversations from "../queries/conversations.js";
import type * as queries_economy from "../queries/economy.js";
import type * as queries_locations from "../queries/locations.js";
import type * as queries_memories from "../queries/memories.js";
import type * as queries_relationships from "../queries/relationships.js";
import type * as queries_world from "../queries/world.js";
import type * as systems_conversations from "../systems/conversations.js";
import type * as systems_decisions from "../systems/decisions.js";
import type * as systems_economy from "../systems/economy.js";
import type * as systems_events from "../systems/events.js";
import type * as systems_movement from "../systems/movement.js";
import type * as systems_needs from "../systems/needs.js";
import type * as systems_relationships from "../systems/relationships.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  "actions/generateEmbedding": typeof actions_generateEmbedding;
  "actions/generateReflection": typeof actions_generateReflection;
  "actions/generateResponse": typeof actions_generateResponse;
  "ai/memories": typeof ai_memories;
  "ai/ollama": typeof ai_ollama;
  "ai/prompts": typeof ai_prompts;
  "ai/sentiment": typeof ai_sentiment;
  "ai/templates": typeof ai_templates;
  "ai/topics": typeof ai_topics;
  crons: typeof crons;
  "engine/constants": typeof engine_constants;
  "engine/tick": typeof engine_tick;
  "helpers/actionHelpers": typeof helpers_actionHelpers;
  "init/agents": typeof init_agents;
  "init/initialize": typeof init_initialize;
  "init/loadMap": typeof init_loadMap;
  "init/memories": typeof init_memories;
  "init/relationships": typeof init_relationships;
  "init/reset": typeof init_reset;
  "lib/pathfinding": typeof lib_pathfinding;
  "lib/prices": typeof lib_prices;
  "lib/types": typeof lib_types;
  "lib/utils": typeof lib_utils;
  "lib/validators": typeof lib_validators;
  nudge: typeof nudge;
  "queries/activityLog": typeof queries_activityLog;
  "queries/agents": typeof queries_agents;
  "queries/conversations": typeof queries_conversations;
  "queries/economy": typeof queries_economy;
  "queries/locations": typeof queries_locations;
  "queries/memories": typeof queries_memories;
  "queries/relationships": typeof queries_relationships;
  "queries/world": typeof queries_world;
  "systems/conversations": typeof systems_conversations;
  "systems/decisions": typeof systems_decisions;
  "systems/economy": typeof systems_economy;
  "systems/events": typeof systems_events;
  "systems/movement": typeof systems_movement;
  "systems/needs": typeof systems_needs;
  "systems/relationships": typeof systems_relationships;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {};
