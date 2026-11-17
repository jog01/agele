ALTER TABLE "trades" DROP CONSTRAINT "trades_signature_unique";--> statement-breakpoint
ALTER TABLE "trades" ADD CONSTRAINT "trades_signature_user_id_unique" UNIQUE("signature","user_id");