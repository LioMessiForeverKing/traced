ALTER TABLE "recordings" ADD COLUMN "source" text DEFAULT 'axis' NOT NULL;--> statement-breakpoint
ALTER TABLE "recordings" ADD CONSTRAINT "recordings_source" CHECK ("recordings"."source" in ('axis', 'upload'));--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.is_upload_recording(recording text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
	select exists (
		select 1
		from public.recordings r
		where r.name = recording
			and r.source = 'upload'
	);
$$;--> statement-breakpoint

REVOKE EXECUTE ON FUNCTION public.is_upload_recording(text) FROM public, anon;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.is_upload_recording(text) TO authenticated;--> statement-breakpoint

CREATE POLICY "recordings_insert_upload_admin" ON "recordings" AS PERMISSIVE FOR INSERT TO "authenticated" WITH CHECK ((select auth.uid()) is not null and public.is_admin() and "recordings"."source" = 'upload' and starts_with("recordings"."name", 'upload_'));--> statement-breakpoint

CREATE POLICY "recording_objects_insert_upload_admin" ON "recording_objects" AS PERMISSIVE FOR INSERT TO "authenticated" WITH CHECK ((select auth.uid()) is not null and public.is_admin() and public.is_upload_recording("recording_objects"."recording_name") and "recording_objects"."storage_path" = "recording_objects"."recording_name" || '/' || "recording_objects"."name");--> statement-breakpoint

CREATE POLICY "recordings_objects_insert_upload_admin"
ON storage.objects
AS PERMISSIVE
FOR INSERT
TO authenticated
WITH CHECK (
	bucket_id = 'recordings'
	and (select auth.uid()) is not null
	and public.is_admin()
	and starts_with((storage.foldername(name))[1], 'upload_')
);
