CREATE TYPE "public"."social_post_kind" AS ENUM('thesis', 'comment');--> statement-breakpoint
CREATE TYPE "public"."social_post_position" AS ENUM('long', 'short', 'none');--> statement-breakpoint
CREATE TABLE "social_reactions" (
	"post_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	CONSTRAINT "social_reactions_post_id_user_id_pk" PRIMARY KEY("post_id","user_id")
);
--> statement-breakpoint
ALTER TABLE "comments" ADD COLUMN "kind" "social_post_kind" DEFAULT 'comment' NOT NULL;--> statement-breakpoint
ALTER TABLE "comments" ADD COLUMN "position" "social_post_position" DEFAULT 'none' NOT NULL;--> statement-breakpoint
ALTER TABLE "comments" ADD COLUMN "thesis_id" uuid;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "bio" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "demo" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "social_reactions" ADD CONSTRAINT "social_reactions_post_id_comments_id_fk" FOREIGN KEY ("post_id") REFERENCES "public"."comments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "social_reactions" ADD CONSTRAINT "social_reactions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comments" ADD CONSTRAINT "comments_thesis_id_comments_id_fk" FOREIGN KEY ("thesis_id") REFERENCES "public"."comments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "comments_thesis_idx" ON "comments" USING btree ("thesis_id");--> statement-breakpoint
CREATE INDEX "comments_feed_idx" ON "comments" USING btree (date_trunc('second', "created_at" AT TIME ZONE 'UTC'),"id") WHERE "comments"."kind" = 'thesis';--> statement-breakpoint
CREATE INDEX "trades_feed_idx" ON "trades" USING btree (date_trunc('second', "executed_at" AT TIME ZONE 'UTC'),"id");--> statement-breakpoint
ALTER TABLE "comments" ADD CONSTRAINT "comments_thesis_no_parent" CHECK ("comments"."kind" <> 'thesis' OR "comments"."thesis_id" IS NULL);