CREATE TABLE "social_follow_actions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "theses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"wallet" text NOT NULL,
	"mint" text NOT NULL,
	"position_id" uuid NOT NULL,
	CONSTRAINT "theses_wallet_mint_positionId_unique" UNIQUE("wallet","mint","position_id")
);
--> statement-breakpoint
ALTER TABLE "comments" DROP CONSTRAINT "comments_thesis_no_parent";--> statement-breakpoint
ALTER TABLE "comments" DROP CONSTRAINT "comments_thesis_id_comments_id_fk";
--> statement-breakpoint
ALTER TABLE "comments" ADD COLUMN "parent_id" uuid;--> statement-breakpoint
ALTER TABLE "comments" ADD COLUMN "pinned" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "social_follow_actions" ADD CONSTRAINT "social_follow_actions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "theses" ADD CONSTRAINT "theses_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "theses" ADD CONSTRAINT "theses_mint_tokens_mint_fk" FOREIGN KEY ("mint") REFERENCES "public"."tokens"("mint") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "theses" ADD CONSTRAINT "theses_position_id_trades_id_fk" FOREIGN KEY ("position_id") REFERENCES "public"."trades"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "social_follow_actions_user_time_idx" ON "social_follow_actions" USING btree ("user_id","created_at");--> statement-breakpoint
ALTER TABLE "comments" ADD CONSTRAINT "comments_thesis_id_theses_id_fk" FOREIGN KEY ("thesis_id") REFERENCES "public"."theses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comments" ADD CONSTRAINT "comments_parent_id_comments_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."comments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "comments_parent_idx" ON "comments" USING btree ("parent_id");--> statement-breakpoint
CREATE UNIQUE INDEX "comments_pinned_thesis_idx" ON "comments" USING btree ("thesis_id") WHERE "comments"."pinned";--> statement-breakpoint
CREATE INDEX "comments_user_created_idx" ON "comments" USING btree ("user_id","created_at");--> statement-breakpoint
ALTER TABLE "comments" ADD CONSTRAINT "comments_thesis_shape" CHECK ("comments"."kind" <> 'thesis' OR ("comments"."parent_id" IS NULL AND "comments"."thesis_id" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "comments" ADD CONSTRAINT "comments_pin_shape" CHECK (not "comments"."pinned" OR "comments"."kind" = 'thesis');