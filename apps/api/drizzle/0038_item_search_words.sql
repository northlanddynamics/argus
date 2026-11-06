ALTER TABLE "assets" drop column "search";--> statement-breakpoint
ALTER TABLE "assets" ADD COLUMN "search" "tsvector" GENERATED ALWAYS AS (to_tsvector('simple', value || ' ' || match_key || ' ' || regexp_replace(match_key, '[^[:alnum:]]+', ' ', 'g'))) STORED NOT NULL;--> statement-breakpoint
ALTER TABLE "observables" drop column "search";--> statement-breakpoint
ALTER TABLE "observables" ADD COLUMN "search" "tsvector" GENERATED ALWAYS AS (to_tsvector('simple', value || ' ' || match_key || ' ' || regexp_replace(match_key, '[^[:alnum:]]+', ' ', 'g'))) STORED NOT NULL;--> statement-breakpoint
CREATE INDEX "assets_search_idx" ON "assets" USING gin ("search");--> statement-breakpoint
CREATE INDEX "observables_search_idx" ON "observables" USING gin ("search");
