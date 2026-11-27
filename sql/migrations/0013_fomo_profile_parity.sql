CREATE TABLE "public_portfolio_hourly" (
	"user_id" uuid NOT NULL,
	"hour" timestamp with time zone NOT NULL,
	"value_usd" numeric(38, 18) NOT NULL,
	CONSTRAINT "public_portfolio_hourly_user_id_hour_pk" PRIMARY KEY("user_id","hour")
);
--> statement-breakpoint
ALTER TABLE "theses" ADD COLUMN "view_count" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "trades" ADD COLUMN "market_cap_usd" numeric(38, 18);--> statement-breakpoint
ALTER TABLE "public_portfolio_hourly" ADD CONSTRAINT "public_portfolio_hourly_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "public_portfolio_hourly_hour_idx" ON "public_portfolio_hourly" USING btree ("hour");