CREATE TABLE "task_questions" (
	"id" text PRIMARY KEY NOT NULL,
	"task_id" text NOT NULL,
	"addressee_id" text NOT NULL,
	"asked_by" text NOT NULL,
	"question" text NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"asked_at" timestamp with time zone DEFAULT now() NOT NULL,
	"answered_at" timestamp with time zone,
	"answer_comment_id" text,
	"answered_by" text,
	"withdrawn_at" timestamp with time zone,
	"withdrawn_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "task_questions" ADD CONSTRAINT "task_questions_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_questions" ADD CONSTRAINT "task_questions_addressee_id_users_id_fk" FOREIGN KEY ("addressee_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_questions" ADD CONSTRAINT "task_questions_asked_by_users_id_fk" FOREIGN KEY ("asked_by") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_questions" ADD CONSTRAINT "task_questions_answer_comment_id_comments_id_fk" FOREIGN KEY ("answer_comment_id") REFERENCES "public"."comments"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_questions" ADD CONSTRAINT "task_questions_answered_by_users_id_fk" FOREIGN KEY ("answered_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_questions" ADD CONSTRAINT "task_questions_withdrawn_by_users_id_fk" FOREIGN KEY ("withdrawn_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "task_questions_one_open_idx" ON "task_questions" USING btree ("task_id") WHERE status = 'open';--> statement-breakpoint
CREATE INDEX "task_questions_addressee_idx" ON "task_questions" USING btree ("addressee_id","status");--> statement-breakpoint
CREATE INDEX "task_questions_asker_idx" ON "task_questions" USING btree ("asked_by","answered_at");