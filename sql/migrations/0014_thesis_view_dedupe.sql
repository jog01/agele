CREATE TABLE "thesis_viewers" (
	"thesis_id" uuid NOT NULL,
	"viewer_key" text NOT NULL,
	"counted_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "thesis_viewers_thesis_id_viewer_key_pk" PRIMARY KEY("thesis_id","viewer_key")
);
--> statement-breakpoint
ALTER TABLE "thesis_viewers" ADD CONSTRAINT "thesis_viewers_thesis_id_theses_id_fk" FOREIGN KEY ("thesis_id") REFERENCES "public"."theses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "thesis_viewers_counted_at_idx" ON "thesis_viewers" USING btree ("counted_at");