ALTER TABLE "project_members" ADD COLUMN "role" text DEFAULT 'member' NOT NULL;--> statement-breakpoint
ALTER TABLE "project_members" ADD CONSTRAINT "project_members_role" CHECK ("project_members"."role" in ('member', 'viewer'));--> statement-breakpoint

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
			and m.role = 'member'
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
			and m.role = 'member'
	);
$$;--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.has_project_access(project uuid)
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

CREATE OR REPLACE FUNCTION public.has_recording_access(recording text)
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

REVOKE EXECUTE ON FUNCTION public.has_project_access(uuid) FROM public, anon;--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION public.has_recording_access(text) FROM public, anon;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.has_project_access(uuid) TO authenticated;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.has_recording_access(text) TO authenticated;--> statement-breakpoint

DROP POLICY IF EXISTS "projects_select_member" ON "projects";--> statement-breakpoint
CREATE POLICY "projects_select_access" ON "projects" AS PERMISSIVE FOR SELECT TO "authenticated" USING ((select auth.uid()) is not null and public.has_project_access("projects"."id"));--> statement-breakpoint

DROP POLICY IF EXISTS "recordings_select_member" ON "recordings";--> statement-breakpoint
CREATE POLICY "recordings_select_access" ON "recordings" AS PERMISSIVE FOR SELECT TO "authenticated" USING ((select auth.uid()) is not null and public.has_project_access("recordings"."project_id"));--> statement-breakpoint

DROP POLICY IF EXISTS "recording_events_select_member" ON "recording_events";--> statement-breakpoint
CREATE POLICY "recording_events_select_access" ON "recording_events" AS PERMISSIVE FOR SELECT TO "authenticated" USING ((select auth.uid()) is not null and public.has_recording_access("recording_events"."recording_name"));
