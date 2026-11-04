ALTER TABLE "alerts" ADD COLUMN "search" "tsvector" GENERATED ALWAYS AS (setweight(to_tsvector('simple', title || ' ' || external_id || ' ' || coalesce(host, '') || ' ' || coalesce(user_name, '')), 'A') || setweight(to_tsvector('simple', coalesce(description, '')), 'B')) STORED NOT NULL;--> statement-breakpoint
ALTER TABLE "assets" ADD COLUMN "search" "tsvector" GENERATED ALWAYS AS (to_tsvector('simple', value || ' ' || match_key)) STORED NOT NULL;--> statement-breakpoint
ALTER TABLE "cases" ADD COLUMN "search" "tsvector" GENERATED ALWAYS AS (setweight(to_tsvector('simple', title), 'A') || setweight(to_tsvector('simple', jsonb_path_query_array(summary, 'strict $.**.text')), 'B')) STORED NOT NULL;--> statement-breakpoint
ALTER TABLE "observables" ADD COLUMN "search" "tsvector" GENERATED ALWAYS AS (to_tsvector('simple', value || ' ' || match_key)) STORED NOT NULL;--> statement-breakpoint
CREATE INDEX "alerts_search_idx" ON "alerts" USING gin ("search");--> statement-breakpoint
CREATE INDEX "assets_search_idx" ON "assets" USING gin ("search");--> statement-breakpoint
CREATE INDEX "cases_search_idx" ON "cases" USING gin ("search");--> statement-breakpoint
CREATE INDEX "observables_search_idx" ON "observables" USING gin ("search");