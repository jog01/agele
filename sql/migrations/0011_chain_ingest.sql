CREATE TABLE "chain_candles_1m" (
	"source" text NOT NULL,
	"mint" text NOT NULL,
	"time" bigint NOT NULL,
	"open" double precision NOT NULL,
	"high" double precision NOT NULL,
	"low" double precision NOT NULL,
	"close" double precision NOT NULL,
	"volume" double precision NOT NULL,
	"first_trade_key" text NOT NULL,
	"last_trade_key" text NOT NULL,
	CONSTRAINT "chain_candles_1m_source_mint_time_pk" PRIMARY KEY("source","mint","time")
);
--> statement-breakpoint
CREATE TABLE "chain_events" (
	"source" text NOT NULL,
	"signature" text NOT NULL,
	"event_index" bigint NOT NULL,
	CONSTRAINT "chain_events_source_signature_event_index_pk" PRIMARY KEY("source","signature","event_index")
);
--> statement-breakpoint
CREATE TABLE "chain_tokens" (
	"source" text NOT NULL,
	"mint" text NOT NULL,
	"venue" text NOT NULL,
	"pool" text NOT NULL,
	"creator" text NOT NULL,
	"name" text NOT NULL,
	"symbol" text NOT NULL,
	"metadata_uri" text,
	"image_url" text,
	"decimals" integer NOT NULL,
	"total_supply_raw" numeric NOT NULL,
	"curve_progress_bps" integer DEFAULT 0 NOT NULL,
	"launched_at" bigint NOT NULL,
	"migrated_at" bigint,
	"migrated_venue" text,
	"price_usd" double precision DEFAULT 0 NOT NULL,
	"last_trade_key" text,
	CONSTRAINT "chain_tokens_source_mint_pk" PRIMARY KEY("source","mint")
);
--> statement-breakpoint
CREATE TABLE "chain_trades" (
	"source" text NOT NULL,
	"signature" text NOT NULL,
	"event_index" bigint NOT NULL,
	"mint" text NOT NULL,
	"trader" text NOT NULL,
	"side" "trade_side" NOT NULL,
	"venue" text NOT NULL,
	"pool" text NOT NULL,
	"order_key" text NOT NULL,
	"time" bigint NOT NULL,
	"token_amount_raw" numeric NOT NULL,
	"sol_amount_lamports" numeric NOT NULL,
	"price_usd" double precision NOT NULL,
	"amount_usd" double precision NOT NULL,
	CONSTRAINT "chain_trades_source_signature_event_index_pk" PRIMARY KEY("source","signature","event_index")
);
--> statement-breakpoint
ALTER TABLE "chain_candles_1m" ADD CONSTRAINT "chain_candles_1m_source_mint_chain_tokens_source_mint_fk" FOREIGN KEY ("source","mint") REFERENCES "public"."chain_tokens"("source","mint") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chain_trades" ADD CONSTRAINT "chain_trades_source_mint_chain_tokens_source_mint_fk" FOREIGN KEY ("source","mint") REFERENCES "public"."chain_tokens"("source","mint") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "chain_tokens_launch_idx" ON "chain_tokens" USING btree ("source","launched_at");--> statement-breakpoint
CREATE INDEX "chain_tokens_progress_idx" ON "chain_tokens" USING btree ("source","curve_progress_bps");--> statement-breakpoint
CREATE INDEX "chain_tokens_migration_idx" ON "chain_tokens" USING btree ("source","migrated_at");--> statement-breakpoint
CREATE INDEX "chain_trades_mint_time_idx" ON "chain_trades" USING btree ("source","mint","time","order_key");--> statement-breakpoint
CREATE INDEX "chain_trades_time_idx" ON "chain_trades" USING btree ("source","time");