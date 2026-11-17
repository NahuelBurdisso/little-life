CREATE TABLE `activity_log` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`type` text NOT NULL,
	`category` text NOT NULL,
	`importance` real NOT NULL,
	`initiator_id` integer,
	`target_id` integer,
	`agent_ids` text NOT NULL,
	`template_key` text NOT NULL,
	`template_data` text NOT NULL,
	`location_id` integer,
	`source_type` text,
	`source_id` integer,
	`severity` real,
	`metadata` text,
	`timestamp` integer NOT NULL,
	`game_minute` integer,
	`real_timestamp` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_activity_log_game_minute` ON `activity_log` (`game_minute`);--> statement-breakpoint
CREATE INDEX `idx_activity_category_ts` ON `activity_log` (`category`,`timestamp`);--> statement-breakpoint
CREATE INDEX `idx_activity_importance_ts` ON `activity_log` (`importance`,`timestamp`);--> statement-breakpoint
CREATE INDEX `idx_activity_agent` ON `activity_log` (`initiator_id`,`timestamp`);--> statement-breakpoint
CREATE INDEX `idx_activity_log_timestamp` ON `activity_log` (`timestamp`);--> statement-breakpoint
CREATE TABLE `agent_states` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`agent_id` integer NOT NULL,
	`type` text NOT NULL,
	`severity` real NOT NULL,
	`started_at` integer NOT NULL,
	`duration` integer NOT NULL,
	`target_agent_id` integer,
	`source` text NOT NULL,
	`metadata` text,
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`target_agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_agent_states_agent_id` ON `agent_states` (`agent_id`);--> statement-breakpoint
CREATE INDEX `idx_agent_states_agent_type` ON `agent_states` (`agent_id`,`type`);--> statement-breakpoint
CREATE TABLE `agents` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`bio` text NOT NULL,
	`traits` text NOT NULL,
	`personality` text,
	`age` integer NOT NULL,
	`gender` text NOT NULL,
	`sprite_sheet` text NOT NULL,
	`portrait_sprite` text NOT NULL,
	`position` text NOT NULL,
	`current_destination` text,
	`current_location` integer,
	`current_action` text NOT NULL,
	`action_started` integer NOT NULL,
	`action_duration` integer,
	`action_queue` text NOT NULL,
	`current_path` text,
	`schedule` text NOT NULL,
	`daily_plan` text DEFAULT 'null',
	`self_description` text,
	`home` integer NOT NULL,
	`workplace` integer,
	`created_at` integer NOT NULL,
	`is_active` integer NOT NULL,
	`years_in_town` integer,
	`job_years` integer,
	`orientation` text,
	FOREIGN KEY (`current_location`) REFERENCES `locations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`home`) REFERENCES `locations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`workplace`) REFERENCES `locations`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_agents_is_active` ON `agents` (`is_active`);--> statement-breakpoint
CREATE TABLE `app_meta` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `aspirations` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`agent_id` integer NOT NULL,
	`type` text NOT NULL,
	`intensity` real NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`adopted_at` integer NOT NULL,
	`shifted_at` integer,
	`trigger` text NOT NULL,
	`shifted_to` text,
	`description` text,
	`shifted_reason` text
);
--> statement-breakpoint
CREATE INDEX `idx_aspirations_agent_status` ON `aspirations` (`agent_id`,`status`);--> statement-breakpoint
CREATE TABLE `children` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`sex` text NOT NULL,
	`birth_game_minute` integer NOT NULL,
	`mother_id` integer NOT NULL,
	`father_id` integer,
	`true_father_id` integer,
	`home` integer,
	`alive` integer DEFAULT true NOT NULL,
	`paternity_fact_id` integer,
	`paternity_revealed` integer DEFAULT false NOT NULL,
	FOREIGN KEY (`mother_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`father_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`true_father_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`home`) REFERENCES `locations`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_children_mother` ON `children` (`mother_id`);--> statement-breakpoint
CREATE INDEX `idx_children_father` ON `children` (`father_id`);--> statement-breakpoint
CREATE TABLE `conversation_queue` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`participants` text NOT NULL,
	`tier` text NOT NULL,
	`priority` integer NOT NULL,
	`trigger_reason` text NOT NULL,
	`topic` text,
	`queued_at` integer NOT NULL,
	`max_wait` integer NOT NULL,
	`deadline_game_min` integer
);
--> statement-breakpoint
CREATE INDEX `idx_conversation_queue_priority` ON `conversation_queue` (`priority`);--> statement-breakpoint
CREATE TABLE `conversation_scheduler_state` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`active_llm_conversations` text NOT NULL,
	`max_concurrent_llm` integer NOT NULL,
	`max_queue_size` integer NOT NULL,
	`max_turns_deep` integer NOT NULL,
	`max_turns_standard` integer NOT NULL,
	`template_fallback_after_ms` integer NOT NULL,
	`stats` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `conversations` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`participants` text NOT NULL,
	`messages` text NOT NULL,
	`location` integer,
	`trigger_reason` text NOT NULL,
	`topic` text,
	`status` text NOT NULL,
	`started_at` integer NOT NULL,
	`ended_at` integer,
	`sentiment` real NOT NULL,
	`max_turns` integer NOT NULL,
	`quality_score` real,
	`quality_breakdown` text,
	FOREIGN KEY (`location`) REFERENCES `locations`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_conversations_status` ON `conversations` (`status`);--> statement-breakpoint
CREATE TABLE `economy` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`agent_id` integer NOT NULL,
	`job` text NOT NULL,
	`job_title` text NOT NULL,
	`salary` real NOT NULL,
	`work_performance` real NOT NULL,
	`money` real NOT NULL,
	`daily_expenses` real NOT NULL,
	`inventory` text NOT NULL,
	`last_payday` integer NOT NULL,
	`production_remainder` real NOT NULL,
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_economy_agent_id` ON `economy` (`agent_id`);--> statement-breakpoint
CREATE TABLE `economy_transactions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`from_agent` integer,
	`to_agent` integer,
	`amount` real NOT NULL,
	`reason` text NOT NULL,
	`items_exchanged` text,
	`location_id` integer,
	`timestamp` integer NOT NULL,
	FOREIGN KEY (`location_id`) REFERENCES `locations`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_economy_transactions_timestamp` ON `economy_transactions` (`timestamp`);--> statement-breakpoint
CREATE INDEX `idx_economy_transactions_to_agent` ON `economy_transactions` (`to_agent`);--> statement-breakpoint
CREATE TABLE `gazette_issues` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`day` integer NOT NULL,
	`season` text NOT NULL,
	`headline` text NOT NULL,
	`articles` text NOT NULL,
	`gossip` text,
	`covers_to_tick` integer NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `goals` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`agent_id` integer NOT NULL,
	`type` text NOT NULL,
	`target_id` integer,
	`motivation` text NOT NULL,
	`priority` real NOT NULL,
	`progress` real DEFAULT 0 NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer,
	`completed_at` integer,
	`description` text,
	`strategy` text,
	`mapped_interactions` text,
	`pivot_count` integer DEFAULT 0 NOT NULL,
	`source` text DEFAULT 'reactive' NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_goals_agent_status` ON `goals` (`agent_id`,`status`);--> statement-breakpoint
CREATE INDEX `idx_goals_target` ON `goals` (`target_id`);--> statement-breakpoint
CREATE TABLE `interaction_cooldowns` (
	`agent_a` integer NOT NULL,
	`agent_b` integer DEFAULT 0 NOT NULL,
	`type` text NOT NULL,
	`expires_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_cooldown_pk` ON `interaction_cooldowns` (`agent_a`,`agent_b`,`type`);--> statement-breakpoint
CREATE TABLE `interaction_participants` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`interaction_id` integer NOT NULL,
	`agent_id` integer NOT NULL,
	`role` text NOT NULL,
	`awareness` text
);
--> statement-breakpoint
CREATE INDEX `idx_ip_agent` ON `interaction_participants` (`agent_id`);--> statement-breakpoint
CREATE INDEX `idx_ip_interaction` ON `interaction_participants` (`interaction_id`);--> statement-breakpoint
CREATE TABLE `interactions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`type` text NOT NULL,
	`location_id` integer,
	`trigger` text NOT NULL,
	`trigger_rule_id` text,
	`goal_id` integer,
	`outcome` text NOT NULL,
	`severity` real NOT NULL,
	`context` text,
	`narration` text,
	`narration_status` text DEFAULT 'pending' NOT NULL,
	`started_at` integer NOT NULL,
	`resolved_at` integer
);
--> statement-breakpoint
CREATE INDEX `idx_interactions_location_tick` ON `interactions` (`location_id`,`started_at`);--> statement-breakpoint
CREATE TABLE `locations` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`type` text NOT NULL,
	`position` text NOT NULL,
	`entry_point` text NOT NULL,
	`owner` integer,
	`capacity` integer NOT NULL,
	`current_occupants` text NOT NULL,
	`operating_hours` text,
	`services` text NOT NULL,
	`description` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `memories` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`agent_id` integer NOT NULL,
	`type` text NOT NULL,
	`description` text NOT NULL,
	`importance` real NOT NULL,
	`emotional_valence` real DEFAULT 0 NOT NULL,
	`depth` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`last_accessed` integer NOT NULL,
	`embedding` blob,
	`metadata` text DEFAULT '{}' NOT NULL,
	`is_active` integer DEFAULT 1 NOT NULL,
	`parent_ids` text DEFAULT '[]' NOT NULL,
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_memories_agent_active` ON `memories` (`agent_id`,`is_active`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_memories_agent_type` ON `memories` (`agent_id`,`type`,`is_active`);--> statement-breakpoint
CREATE TABLE `needs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`agent_id` integer NOT NULL,
	`hunger` real NOT NULL,
	`energy` real NOT NULL,
	`social` real NOT NULL,
	`comfort` real NOT NULL,
	`fun` real NOT NULL,
	`mood` real NOT NULL,
	`stress` real NOT NULL,
	`decay_rates` text NOT NULL,
	`thresholds` text NOT NULL,
	`mood_modifiers` text NOT NULL,
	`last_updated` integer NOT NULL,
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_needs_agent_id` ON `needs` (`agent_id`);--> statement-breakpoint
CREATE TABLE `relationship_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`agent_a` integer NOT NULL,
	`agent_b` integer NOT NULL,
	`event_type` text NOT NULL,
	`description` text NOT NULL,
	`friendship_delta_ab` real NOT NULL,
	`friendship_delta_ba` real NOT NULL,
	`romance_delta_ab` real NOT NULL,
	`romance_delta_ba` real NOT NULL,
	`trust_delta_ab` real NOT NULL,
	`trust_delta_ba` real NOT NULL,
	`sentiment` real NOT NULL,
	`processed` integer NOT NULL,
	`timestamp` integer NOT NULL,
	`game_minute` integer,
	FOREIGN KEY (`agent_a`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`agent_b`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_relationship_events_processed` ON `relationship_events` (`processed`);--> statement-breakpoint
CREATE TABLE `relationships` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`agent_a` integer NOT NULL,
	`agent_b` integer NOT NULL,
	`friendship_ab` real NOT NULL,
	`friendship_ba` real NOT NULL,
	`romance_ab` real NOT NULL,
	`romance_ba` real NOT NULL,
	`trust_ab` real NOT NULL,
	`trust_ba` real NOT NULL,
	`familiarity` real NOT NULL,
	`interaction_count` integer NOT NULL,
	`last_interaction` integer NOT NULL,
	`last_interaction_minute` integer,
	`status_since_minute` integer,
	`average_interaction_sentiment` real NOT NULL,
	`tags` text NOT NULL,
	`status` text NOT NULL,
	`created_at` integer NOT NULL,
	`last_updated` integer NOT NULL,
	FOREIGN KEY (`agent_a`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`agent_b`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_relationships_agent_a` ON `relationships` (`agent_a`);--> statement-breakpoint
CREATE INDEX `idx_relationships_agent_b` ON `relationships` (`agent_b`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_relationships_pair` ON `relationships` (`agent_a`,`agent_b`);--> statement-breakpoint
CREATE TABLE `shared_knowledge` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`type` text NOT NULL,
	`subject_id` integer NOT NULL,
	`target_id` integer,
	`content` text NOT NULL,
	`sensitivity` integer NOT NULL,
	`known_by` text NOT NULL,
	`created_at` integer NOT NULL,
	`is_active` integer DEFAULT true NOT NULL,
	`reliability` text DEFAULT 'confirmed',
	`source` text NOT NULL,
	`is_public` integer DEFAULT false NOT NULL,
	`revealed_at` integer,
	`paid_at` integer,
	FOREIGN KEY (`subject_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`target_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_shared_knowledge_subject` ON `shared_knowledge` (`subject_id`);--> statement-breakpoint
CREATE INDEX `idx_shared_knowledge_active` ON `shared_knowledge` (`is_active`);--> statement-breakpoint
CREATE TABLE `sim_snapshots` (
	`key` text PRIMARY KEY NOT NULL,
	`world_id` integer NOT NULL,
	`version` integer NOT NULL,
	`game_minute` integer NOT NULL,
	`data` text NOT NULL,
	`saved_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `template_usage` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`template_category` text NOT NULL,
	`agent_a` integer NOT NULL,
	`agent_b` integer NOT NULL,
	`used_at` integer NOT NULL,
	`used_game_min` integer,
	FOREIGN KEY (`agent_a`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`agent_b`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_template_usage_pair_category` ON `template_usage` (`agent_a`,`agent_b`,`template_category`);--> statement-breakpoint
CREATE TABLE `templates` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`category` text NOT NULL,
	`conditions` text NOT NULL,
	`variants` text NOT NULL,
	`cooldown_per_pair` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `world_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`type` text NOT NULL,
	`name` text NOT NULL,
	`description` text NOT NULL,
	`started_at` integer NOT NULL,
	`duration` integer NOT NULL,
	`effects` text NOT NULL,
	`location_id` integer,
	`triggered_by` text NOT NULL,
	`is_active` integer NOT NULL,
	FOREIGN KEY (`location_id`) REFERENCES `locations`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_world_events_is_active` ON `world_events` (`is_active`);--> statement-breakpoint
CREATE TABLE `world_state` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`time` text NOT NULL,
	`day_phase` text NOT NULL,
	`weather` text NOT NULL,
	`weather_duration` integer NOT NULL,
	`tick_speed` real NOT NULL,
	`is_paused` integer NOT NULL,
	`last_tick_completed` real NOT NULL,
	`current_tick_phase` integer NOT NULL,
	`tick_id` text NOT NULL,
	`pending_transitions` text NOT NULL,
	`tax_pool` real NOT NULL,
	`map_width` integer NOT NULL,
	`map_height` integer NOT NULL,
	`collision_grid` text NOT NULL,
	`road_tiles` text NOT NULL,
	`terrain_tiles` text NOT NULL,
	`setup_config` text,
	`rule_overrides` text,
	`world_id` text,
	`civic` text,
	`money_target_per_capita` real,
	`treasury_ramp_left` integer
);
