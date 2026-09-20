CREATE TABLE "platform_admins" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "platform_admins" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "platform_admins" ADD CONSTRAINT "platform_admins_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.is_admin()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
	select exists (
		select 1
		from public.platform_admins a
		where a.user_id = (select auth.uid())
	);
$$;--> statement-breakpoint

REVOKE EXECUTE ON FUNCTION public.is_admin() FROM public, anon;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.is_admin() TO authenticated;--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.is_project_member(project uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
	select public.is_admin() or exists (
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
	select public.is_admin() or exists (
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
	select public.is_admin() or exists (
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
	select public.is_admin() or exists (
		select 1
		from public.recordings r
		join public.project_members m on m.project_id = r.project_id
		where r.name = recording
			and m.user_id = (select auth.uid())
	);
$$;--> statement-breakpoint

CREATE POLICY "platform_admins_select_admin" ON "platform_admins" AS PERMISSIVE FOR SELECT TO "authenticated" USING ((select auth.uid()) is not null and public.is_admin());
