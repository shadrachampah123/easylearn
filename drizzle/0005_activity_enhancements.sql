-- 0005: Enhance activity_logs for real admin activity feed
-- Adds entity_type, entity_id, description for richer audit trail

--> statement-breakpoint
ALTER TABLE \"activity_logs\" ADD COLUMN IF NOT EXISTS \"entity_type\" varchar(100);

--> statement-breakpoint
ALTER TABLE \"activity_logs\" ADD COLUMN IF NOT EXISTS \"entity_id\" uuid;

--> statement-breakpoint
ALTER TABLE \"activity_logs\" ADD COLUMN IF NOT EXISTS \"description\" text;

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS \"activity_logs_entity_idx\" ON \"activity_logs\" USING btree (\"entity_type\", \"entity_id\");

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS \"activity_logs_created_at_idx\" ON \"activity_logs\" USING btree (\"created_at\" DESC);

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS \"activity_logs_user_action_idx\" ON \"activity_logs\" USING btree (\"user_id\", \"action\");
