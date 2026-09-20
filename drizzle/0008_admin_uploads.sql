ALTER TABLE "recordings" ADD COLUMN "source" text DEFAULT 'axis' NOT NULL;--> statement-breakpoint
ALTER TABLE "recordings" ADD CONSTRAINT "recordings_source" CHECK ("recordings"."source" in ('axis', 'upload'));--> statement-breakpoint

CREATE POLICY "recordings_insert_upload_admin" ON "recordings" AS PERMISSIVE FOR INSERT TO "authenticated" WITH CHECK ((select auth.uid()) is not null and public.is_admin() and "recordings"."source" = 'upload' and starts_with("recordings"."name", 'upload_') and "recordings"."analysis_status" = 'pending' and "recordings"."analysis_attempts" = 0 and "recordings"."analysed_at" is null and "recordings"."analysis_error" is null);--> statement-breakpoint

CREATE POLICY "recording_objects_insert_upload_admin" ON "recording_objects" AS PERMISSIVE FOR INSERT TO "authenticated" WITH CHECK ((select auth.uid()) is not null and public.is_admin() and exists (select 1 from public.recordings r where r.name = "recording_objects"."recording_name" and r.source = 'upload') and "recording_objects"."storage_path" = "recording_objects"."recording_name" || '/' || "recording_objects"."name");--> statement-breakpoint

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
