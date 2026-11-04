CREATE TABLE "sso_provider" (
	"id" text PRIMARY KEY NOT NULL,
	"issuer" text NOT NULL,
	"oidc_config" text,
	"saml_config" text,
	"user_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"organization_id" text,
	"domain" text NOT NULL,
	"provision_analysts" boolean DEFAULT false NOT NULL,
	"updated_at" timestamp NOT NULL,
	CONSTRAINT "sso_provider_provider_id_unique" UNIQUE("provider_id")
);
--> statement-breakpoint
ALTER TABLE "session" ADD COLUMN "signed_in_with_sso" boolean DEFAULT false;--> statement-breakpoint
ALTER TABLE "sso_provider" ADD CONSTRAINT "sso_provider_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
-- One SAML connection per Organization, and an email domain routes to at most one of them.
CREATE UNIQUE INDEX "sso_provider_organization_id_unique" ON "sso_provider" ("organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "sso_provider_domain_unique" ON "sso_provider" ("domain");--> statement-breakpoint
ALTER TABLE "sso_provider" ADD CONSTRAINT "sso_provider_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
