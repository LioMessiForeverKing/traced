CREATE POLICY "recordings_objects_select_member"
ON storage.objects
AS PERMISSIVE
FOR SELECT
TO authenticated
USING (
	bucket_id = 'recordings'
	and (select auth.uid()) is not null
	and public.is_recording_member((storage.foldername(name))[1])
);
