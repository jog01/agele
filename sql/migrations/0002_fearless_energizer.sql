ALTER TABLE "follows" DROP CONSTRAINT "follows_followee_id_users_id_fk";
--> statement-breakpoint
ALTER TABLE "follows" DROP CONSTRAINT "follows_follower_id_users_id_fk";
--> statement-breakpoint
DROP INDEX "follows_followee_idx";--> statement-breakpoint
ALTER TABLE "follows" DROP CONSTRAINT "follows_follower_id_followee_id_pk";--> statement-breakpoint
ALTER TABLE "follows" ADD COLUMN "followee_wallet" text;--> statement-breakpoint
UPDATE "follows" SET "followee_wallet" = "users"."wallet_address" FROM "users" WHERE "follows"."followee_id" = "users"."id";--> statement-breakpoint
DELETE FROM "follows" WHERE "followee_wallet" IS NULL;--> statement-breakpoint
ALTER TABLE "follows" ALTER COLUMN "followee_wallet" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "follows" ADD CONSTRAINT "follows_follower_id_followee_wallet_pk" PRIMARY KEY("follower_id","followee_wallet");--> statement-breakpoint
ALTER TABLE "follows" ADD CONSTRAINT "follows_follower_id_users_id_fk" FOREIGN KEY ("follower_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "follows_followee_idx" ON "follows" USING btree ("followee_wallet");--> statement-breakpoint
ALTER TABLE "follows" DROP COLUMN "followee_id";