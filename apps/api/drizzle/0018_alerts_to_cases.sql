ALTER TABLE "alerts" ADD COLUMN "case_id" text;--> statement-breakpoint
ALTER TABLE "alerts" ADD COLUMN "attached_by_id" text;--> statement-breakpoint
ALTER TABLE "alerts" ADD COLUMN "attached_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "alerts" ADD COLUMN "dismissal_reason" text;--> statement-breakpoint
ALTER TABLE "alerts" ADD COLUMN "dismissal_comment" text;--> statement-breakpoint
ALTER TABLE "alerts" ADD COLUMN "dismissed_by_id" text;--> statement-breakpoint
ALTER TABLE "alerts" ADD COLUMN "dismissed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "alerts" ADD CONSTRAINT "alerts_case_id_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."cases"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "alerts" ADD CONSTRAINT "alerts_attached_by_id_user_id_fk" FOREIGN KEY ("attached_by_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "alerts" ADD CONSTRAINT "alerts_dismissed_by_id_user_id_fk" FOREIGN KEY ("dismissed_by_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "alerts_case_idx" ON "alerts" USING btree ("case_id");--> statement-breakpoint
ALTER TABLE "alerts" ADD CONSTRAINT "alerts_status" CHECK (("alerts"."status" = 'attached') = ("alerts"."case_id" IS NOT NULL) AND ("alerts"."status" = 'dismissed') = ("alerts"."dismissal_reason" IS NOT NULL));