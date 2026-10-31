ALTER TABLE "cases" ADD COLUMN "resolution" text;--> statement-breakpoint
ALTER TABLE "cases" ADD COLUMN "closed_by_id" text;--> statement-breakpoint
ALTER TABLE "cases" ADD COLUMN "closed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "cases" ADD CONSTRAINT "cases_closed_by_id_user_id_fk" FOREIGN KEY ("closed_by_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cases" ADD CONSTRAINT "cases_closed_has_resolution" CHECK (("cases"."status" = 'closed') = ("cases"."resolution" IS NOT NULL)
        AND ("cases"."status" = 'closed') = ("cases"."closed_by_id" IS NOT NULL)
        AND ("cases"."status" = 'closed') = ("cases"."closed_at" IS NOT NULL));