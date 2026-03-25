CREATE TABLE `activity_log` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`type` text NOT NULL,
	`message` text NOT NULL,
	`agent_ids` text NOT NULL,
	`timestamp` integer NOT NULL,
	`real_timestamp` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_activity_log_timestamp` ON `activity_log` (`timestamp`);--> statement-breakpoint
CREATE INDEX `idx_activity_log_type_timestamp` ON `activity_log` (`type`,`timestamp`);--> statement-breakpoint
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
	`home` integer NOT NULL,
	`workplace` integer,
	`created_at` integer NOT NULL,
	`is_active` integer NOT NULL,
	FOREIGN KEY (`current_location`) REFERENCES `locations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`home`) REFERENCES `locations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`workplace`) REFERENCES `locations`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_agents_is_active` ON `agents` (`is_active`);--> statement-breakpoint
CREATE TABLE `conversation_queue` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`participants` text NOT NULL,
	`tier` text NOT NULL,
	`priority` integer NOT NULL,
	`trigger_reason` text NOT NULL,
	`topic` text,
	`queued_at` integer NOT NULL,
	`max_wait` integer NOT NULL
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
	`content` text NOT NULL,
	`type` text NOT NULL,
	`importance` real NOT NULL,
	`emotional_valence` real NOT NULL,
	`embedding` blob,
	`related_agents` text NOT NULL,
	`related_location` integer,
	`tags` text NOT NULL,
	`timestamp` integer NOT NULL,
	`access_count` integer NOT NULL,
	`last_accessed` integer NOT NULL,
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`related_location`) REFERENCES `locations`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_memories_agent_id` ON `memories` (`agent_id`);--> statement-breakpoint
CREATE INDEX `idx_memories_agent_id_timestamp` ON `memories` (`agent_id`,`timestamp`);--> statement-breakpoint
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
CREATE TABLE `template_usage` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`template_category` text NOT NULL,
	`agent_a` integer NOT NULL,
	`agent_b` integer NOT NULL,
	`used_at` integer NOT NULL,
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
	`collision_grid` text NOT NULL
);
