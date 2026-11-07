ALTER TABLE "case_assets" ADD COLUMN "internal" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "case_observables" ADD COLUMN "internal" boolean DEFAULT false NOT NULL;