CREATE TABLE "projects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "projects" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "project_members" (
	"project_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_members_project_id_user_id_pk" PRIMARY KEY("project_id","user_id")
);
--> statement-breakpoint
ALTER TABLE "project_members" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "project_members" ADD CONSTRAINT "project_members_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_members" ADD CONSTRAINT "project_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint

insert into "projects" ("id", "name")
values ('00000000-0000-4000-8000-000000000001', 'Bootstrap project')
on conflict ("id") do nothing;--> statement-breakpoint

ALTER TABLE "bws_systems" ADD COLUMN "project_id" uuid;--> statement-breakpoint
UPDATE "bws_systems" SET "project_id" = '00000000-0000-4000-8000-000000000001' WHERE "project_id" IS NULL;--> statement-breakpoint
ALTER TABLE "bws_systems" ALTER COLUMN "project_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "bws_systems" ADD CONSTRAINT "bws_systems_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint

ALTER TABLE "camera_users" ADD COLUMN "project_id" uuid;--> statement-breakpoint
UPDATE "camera_users" SET "project_id" = '00000000-0000-4000-8000-000000000001' WHERE "project_id" IS NULL;--> statement-breakpoint
ALTER TABLE "camera_users" ALTER COLUMN "project_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "camera_users" ADD CONSTRAINT "camera_users_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint

ALTER TABLE "devices" ADD COLUMN "project_id" uuid;--> statement-breakpoint
UPDATE "devices" SET "project_id" = '00000000-0000-4000-8000-000000000001' WHERE "project_id" IS NULL;--> statement-breakpoint
ALTER TABLE "devices" ALTER COLUMN "project_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "devices" ADD CONSTRAINT "devices_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint

ALTER TABLE "recordings" ADD COLUMN "project_id" uuid;--> statement-breakpoint
UPDATE "recordings" SET "project_id" = '00000000-0000-4000-8000-000000000001' WHERE "project_id" IS NULL;--> statement-breakpoint
ALTER TABLE "recordings" ALTER COLUMN "project_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "recordings" ADD CONSTRAINT "recordings_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "recordings_project_id" ON "recordings" USING btree ("project_id");--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.is_project_member(project uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
	select exists (
		select 1
		from public.project_members m
		where m.project_id = project
			and m.user_id = (select auth.uid())
	);
$$;--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.is_recording_member(recording text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
	select exists (
		select 1
		from public.recordings r
		join public.project_members m on m.project_id = r.project_id
		where r.name = recording
			and m.user_id = (select auth.uid())
	);
$$;--> statement-breakpoint

REVOKE EXECUTE ON FUNCTION public.is_project_member(uuid) FROM public, anon;--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION public.is_recording_member(text) FROM public, anon;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.is_project_member(uuid) TO authenticated;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.is_recording_member(text) TO authenticated;--> statement-breakpoint

CREATE POLICY "projects_select_member" ON "projects" AS PERMISSIVE FOR SELECT TO "authenticated" USING ((select auth.uid()) is not null and public.is_project_member("projects"."id"));--> statement-breakpoint
CREATE POLICY "project_members_select_member" ON "project_members" AS PERMISSIVE FOR SELECT TO "authenticated" USING ((select auth.uid()) is not null and public.is_project_member("project_members"."project_id"));--> statement-breakpoint
CREATE POLICY "bws_systems_select_member" ON "bws_systems" AS PERMISSIVE FOR SELECT TO "authenticated" USING ((select auth.uid()) is not null and public.is_project_member("bws_systems"."project_id"));--> statement-breakpoint
CREATE POLICY "camera_users_select_member" ON "camera_users" AS PERMISSIVE FOR SELECT TO "authenticated" USING ((select auth.uid()) is not null and public.is_project_member("camera_users"."project_id"));--> statement-breakpoint
CREATE POLICY "devices_select_member" ON "devices" AS PERMISSIVE FOR SELECT TO "authenticated" USING ((select auth.uid()) is not null and public.is_project_member("devices"."project_id"));--> statement-breakpoint
CREATE POLICY "recordings_select_member" ON "recordings" AS PERMISSIVE FOR SELECT TO "authenticated" USING ((select auth.uid()) is not null and public.is_project_member("recordings"."project_id"));--> statement-breakpoint
CREATE POLICY "recording_objects_select_member" ON "recording_objects" AS PERMISSIVE FOR SELECT TO "authenticated" USING ((select auth.uid()) is not null and public.is_recording_member("recording_objects"."recording_name"));--> statement-breakpoint
CREATE POLICY "recording_events_select_member" ON "recording_events" AS PERMISSIVE FOR SELECT TO "authenticated" USING ((select auth.uid()) is not null and public.is_recording_member("recording_events"."recording_name"));
