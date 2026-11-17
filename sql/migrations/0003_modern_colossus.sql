CREATE TYPE "public"."swap_status" AS ENUM('issued', 'submitted', 'confirmed', 'failed', 'expired');--> statement-breakpoint
CREATE TABLE "swaps" (
	"request_id" text PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"wallet" text NOT NULL,
	"input_mint" text NOT NULL,
	"output_mint" text NOT NULL,
	"in_amount" text NOT NULL,
	"quoted_out_amount" text NOT NULL,
	"input_amount_result" text,
	"output_amount_result" text,
	"status" "swap_status" DEFAULT 'issued' NOT NULL,
	"signature" text,
	"error" text,
	"error_code" text,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "swaps_signature_unique" UNIQUE("signature")
);
--> statement-breakpoint
ALTER TABLE "swaps" ADD CONSTRAINT "swaps_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "swaps_user_created_idx" ON "swaps" USING btree ("user_id","created_at");