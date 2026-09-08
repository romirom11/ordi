ALTER TABLE "agent_profiles" ALTER COLUMN "max_turns" SET DEFAULT 200;--> statement-breakpoint
-- Profiles still on the old default (60 steps) move to the new one: the
-- first real task showed 60 runs out before the agent can even report.
UPDATE agent_profiles SET max_turns = 200 WHERE max_turns = 60;
