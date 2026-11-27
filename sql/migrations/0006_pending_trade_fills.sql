CREATE TABLE "pending_trade_fills" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"mint" text NOT NULL,
	"signature" text NOT NULL,
	"executed_at" timestamp with time zone NOT NULL,
	CONSTRAINT "pending_trade_fills_userId_signature_unique" UNIQUE("user_id","signature")
);
--> statement-breakpoint
ALTER TABLE "pending_trade_fills" ADD CONSTRAINT "pending_trade_fills_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "pending_trade_fills_position_idx" ON "pending_trade_fills" USING btree ("user_id","mint","executed_at","id");