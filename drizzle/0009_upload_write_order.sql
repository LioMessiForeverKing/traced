DROP POLICY "recordings_insert_upload_admin" ON "recordings";--> statement-breakpoint

CREATE POLICY "recordings_insert_upload_admin" ON "recordings" AS PERMISSIVE FOR INSERT TO "authenticated" WITH CHECK ((select auth.uid()) is not null and public.is_admin() and "recordings"."source" = 'upload' and starts_with("recordings"."name", 'upload_') and "recordings"."status" = 'uploading' and "recordings"."analysis_status" = 'pending' and "recordings"."analysis_attempts" = 0 and "recordings"."analysed_at" is null and "recordings"."analysis_error" is null);--> statement-breakpoint

CREATE POLICY "recordings_update_upload_complete" ON "recordings" AS PERMISSIVE FOR UPDATE TO "authenticated" USING ((select auth.uid()) is not null and public.is_admin() and "recordings"."source" = 'upload' and "recordings"."status" = 'uploading') WITH CHECK ("recordings"."status" = 'complete');--> statement-breakpoint

REVOKE UPDATE ON "recordings" FROM "anon", "authenticated";--> statement-breakpoint
GRANT UPDATE ("status") ON "recordings" TO "authenticated";--> statement-breakpoint

DROP POLICY "recording_objects_insert_upload_admin" ON "recording_objects";--> statement-breakpoint

CREATE POLICY "recording_objects_insert_upload_admin" ON "recording_objects" AS PERMISSIVE FOR INSERT TO "authenticated" WITH CHECK ((select auth.uid()) is not null and public.is_admin() and exists (select 1 from public.recordings r where r.name = "recording_objects"."recording_name" and r.source = 'upload' and r.status = 'uploading') and "recording_objects"."storage_path" = "recording_objects"."recording_name" || '/' || "recording_objects"."name");--> statement-breakpoint

DROP POLICY "recordings_objects_insert_upload_admin" ON storage.objects;--> statement-breakpoint

CREATE POLICY "recordings_objects_insert_upload_admin"
ON storage.objects
AS PERMISSIVE
FOR INSERT
TO authenticated
WITH CHECK (
	bucket_id = 'recordings'
	and (select auth.uid()) is not null
	and public.is_admin()
	and exists (
		select 1
		from public.recordings r
		where r.name = (storage.foldername(objects.name))[1]
			and r.source = 'upload'
			and r.status = 'uploading'
	)
);
