CREATE TABLE "feed_discussions" (
	"key" text PRIMARY KEY NOT NULL,
	"mint" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "feed_reactions" (
	"discussion_key" text NOT NULL,
	"user_id" uuid NOT NULL,
	CONSTRAINT "feed_reactions_discussion_key_user_id_pk" PRIMARY KEY("discussion_key","user_id")
);
--> statement-breakpoint
ALTER TABLE "comments" ADD COLUMN "discussion_key" text;--> statement-breakpoint
ALTER TABLE "feed_discussions" ADD CONSTRAINT "feed_discussions_mint_tokens_mint_fk" FOREIGN KEY ("mint") REFERENCES "public"."tokens"("mint") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feed_reactions" ADD CONSTRAINT "feed_reactions_discussion_key_feed_discussions_key_fk" FOREIGN KEY ("discussion_key") REFERENCES "public"."feed_discussions"("key") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feed_reactions" ADD CONSTRAINT "feed_reactions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comments" ADD CONSTRAINT "comments_discussion_key_feed_discussions_key_fk" FOREIGN KEY ("discussion_key") REFERENCES "public"."feed_discussions"("key") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "comments_discussion_idx" ON "comments" USING btree ("discussion_key");--> statement-breakpoint
CREATE INDEX "trades_demo_seed_idx" ON "trades" USING btree ("id") WHERE "trades"."signature" like 'demo:%';--> statement-breakpoint
ALTER TABLE "comments" ADD CONSTRAINT "comments_discussion_shape" CHECK ("comments"."discussion_key" IS NULL OR ("comments"."thesis_id" IS NULL AND "comments"."kind" = 'comment'));