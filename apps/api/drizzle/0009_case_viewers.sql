CREATE TABLE "case_viewers" (
	"socket_id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"case_id" text NOT NULL,
	"user_id" text NOT NULL,
	"seen_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "case_viewers" ADD CONSTRAINT "case_viewers_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "case_viewers" ADD CONSTRAINT "case_viewers_case_id_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."cases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "case_viewers" ADD CONSTRAINT "case_viewers_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "case_viewers_case_idx" ON "case_viewers" USING btree ("case_id");--> statement-breakpoint
CREATE INDEX "case_viewers_seen_idx" ON "case_viewers" USING btree ("seen_at");