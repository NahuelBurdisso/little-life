-- Migration: 0001_memory_stream
-- Rename content->description, timestamp->created_at, drop access_count/related_agents/related_location/tags
-- Add depth, metadata, is_active, parent_ids to memories.
-- Rename facts -> shared_knowledge.

CREATE TABLE `memories_new` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `agent_id` integer NOT NULL REFERENCES `agents`(`id`),
  `type` text NOT NULL,
  `description` text NOT NULL,
  `importance` real NOT NULL,
  `emotional_valence` real NOT NULL DEFAULT 0,
  `depth` integer NOT NULL DEFAULT 0,
  `created_at` integer NOT NULL,
  `last_accessed` integer NOT NULL,
  `embedding` blob,
  `metadata` text NOT NULL DEFAULT '{}',
  `is_active` integer NOT NULL DEFAULT 1,
  `parent_ids` text NOT NULL DEFAULT '[]'
);
-->statement-breakpoint
INSERT INTO `memories_new` (
  `id`,
  `agent_id`,
  `type`,
  `description`,
  `importance`,
  `emotional_valence`,
  `depth`,
  `created_at`,
  `last_accessed`,
  `embedding`,
  `metadata`,
  `is_active`,
  `parent_ids`
)
SELECT
  `id`,
  `agent_id`,
  `type`,
  `content`,
  `importance`,
  `emotional_valence`,
  0,
  `timestamp`,
  `last_accessed`,
  `embedding`,
  json_object(
    'related_agents', json(`related_agents`),
    'location_id', CASE WHEN `related_location` IS NULL THEN NULL ELSE `related_location` END,
    'tags', json(`tags`)
  ),
  1,
  '[]'
FROM `memories`;
-->statement-breakpoint
DROP TABLE `memories`;
-->statement-breakpoint
ALTER TABLE `memories_new` RENAME TO `memories`;
-->statement-breakpoint
CREATE INDEX `idx_memories_agent_active` ON `memories` (`agent_id`, `is_active`, `created_at`);
-->statement-breakpoint
CREATE INDEX `idx_memories_agent_type` ON `memories` (`agent_id`, `type`, `is_active`);
-->statement-breakpoint
ALTER TABLE `facts` RENAME TO `shared_knowledge`;
-->statement-breakpoint
DROP INDEX IF EXISTS `idx_facts_subject`;
-->statement-breakpoint
DROP INDEX IF EXISTS `idx_facts_active`;
-->statement-breakpoint
CREATE INDEX `idx_shared_knowledge_subject` ON `shared_knowledge` (`subject_id`);
-->statement-breakpoint
CREATE INDEX `idx_shared_knowledge_active` ON `shared_knowledge` (`is_active`);
