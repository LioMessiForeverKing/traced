# Traced

A content destination for Axis body worn cameras. A worker wears the camera in a vest; when the
camera docks, the AXIS W800 system controller pushes every recording here, and it lands in
Supabase — the clip in Storage, the who/when/where in Postgres.

Recordings are not live-streamed. The W800 offloads them after docking, one HTTPS push at a time,
speaking a small subset of the OpenStack Swift API. This service is that server.

## Run it

```bash
cp .env.example .env.local        # then fill in the blanks
npm install
npm run dev
```

`CD_PUBLIC_URL` must be the address the W800 can reach on your network, not `localhost`.

`PROJECT_ID` is the site this intake serves. One deployment serves one W800, which serves one
construction site, so the project is configuration rather than something the Axis protocol carries.
Migration `0003` seeds a `Bootstrap project` row at `00000000-0000-4000-8000-000000000001` for
local use; a real deployment inserts its own row in `projects` and points `PROJECT_ID` at it.

## Connect a W800

```bash
npm run connection-file           # writes traced-connection.json
```

Upload that file in AXIS Body Worn Manager under **Content destination**. From then on, every
docked camera offloads to this service.

## Prove it without a camera

```bash
npm run dev                       # terminal 1
npm run fake-w800                 # terminal 2
```

`fake-w800` behaves like a system controller offloading one recording: it authenticates, registers
a user and a device, creates a recording, uploads a clip and a GPS trail, and marks it complete.
Check `recordings` and `recording_objects` in Supabase afterwards.

The clip the fake sends is synthetic bytes, not real video, so analysis fails on it with
`moov atom not found`. Pass a real MP4 as the second argument to watch the whole chain work:

```bash
npm run fake-w800 -- http://localhost:8080 ./some-clip.mp4
```

Set `ANALYSIS_ENABLED=false` to run the intake without an OpenAI key.

## Analysis

Once a recording reaches `Status: Complete`, a loop inside this same process picks it up: it claims
the row, pulls scene-change frames out of the clip with ffmpeg, sends them to OpenAI, and writes
timestamped rows into `recording_events`. The claim is a `FOR UPDATE SKIP LOCKED` on the recording,
so the loop can move into its own process later without any of this code changing.

Frames are chosen two ways at once, and the first one is what makes a long recording work.
`ANALYSIS_MAX_FRAMES` is divided into the clip's duration to give a sampling interval, and a frame
is taken whenever that interval has elapsed since the last one — so a two-hour recording is covered
end to end rather than densely at the start. On top of that, any scene change above
`ANALYSIS_SCENE_THRESHOLD` also takes a frame, which adds detail wherever the view actually changes.

That split matters because body worn footage is one continuous shot from a moving camera and never
cuts. Scene detection alone finds nothing in it: at the default threshold a 17-second clip yielded a
single frame, and so would a two-hour one.

A failed analysis is retried. `analysis_attempts` counts every failure, and the claim query picks a
failed recording back up once ten minutes have passed, up to three attempts. That matters because
the clip is never the thing that failed — an OpenAI outage, a network blip or a timeout all mark a
recording failed while its footage sits intact in Storage, and before this a transient error lost a
shift permanently. After three attempts it stays failed rather than retrying a genuinely broken clip
forever.

Tune it with `ANALYSIS_MAX_FRAMES`, `ANALYSIS_SCENE_THRESHOLD`, `ANALYSIS_FRAME_WIDTH` and
`ANALYSIS_POLL_MS`. Frame budget is the cost lever: frames dominate the bill. `OPENAI_MODEL`
defaults to `gpt-5.5`; drop to a smaller model for volume without touching code.

## Let a person in

Nothing browser-facing works until a real account is a member of a project. `auth.users` starts
empty, and a member of nothing sees nothing.

```bash
npm run grant-access -- someone@example.com
```

Creates the Supabase Auth account if it does not exist, adds it to `PROJECT_ID` — the project this
intake is stamping onto everything it writes, so the new member can see the footage that is
actually here — and prints the generated password once. Pass a different project id as a second
argument to use another one, or set `GRANT_PASSWORD` to choose the password instead of having one
generated. Running it twice is safe and changes nothing.

It does not create projects. A new site is one `insert into projects (name) values ('...')`, and
its id is what you pass as the second argument.

## Who can read what

Every table has RLS on and exactly one policy: `SELECT`, `TO authenticated`, allowed only for
members of the row's project. There are no `INSERT`, `UPDATE` or `DELETE` policies anywhere,
because the browser never writes — the intake holds the service-role key and writes everything,
and the service role bypasses RLS. A dashboard bug therefore cannot alter evidence.

Membership is flat. A row in `project_members` means you see that project's recordings, clips,
events, devices, camera users and controllers; no row means you see nothing at all. Workers wearing
the cameras are `camera_users`, an Axis identity with no login and no relation to `auth.users`.

`recording_objects` and `recording_events` carry no `project_id`. They reach a project through
their recording, so a clip can never disagree with the recording it belongs to.

The video itself is governed the same way. The `recordings` bucket is private and `storage.objects`
carries one `SELECT` policy for members, keyed on the storage path — an object lives at
`<recording_name>/<file>`, so `storage.foldername(name)` yields the recording and the same
`is_recording_member` answers for the bytes as for the rows. A member therefore mints their own
signed URL straight from the browser with the publishable key; there is no endpoint in between and
the service-role key never reaches the dashboard. Listing the bucket is filtered by the same policy,
so a member sees only their own recordings' folders.

Both policy predicates go through `SECURITY DEFINER` functions — `is_project_member(uuid)` and
`is_recording_member(text)`. A policy that queried `project_members` directly would have its own
subquery filtered by that table's policy, and recurse.

```bash
npm run test:rls
```

That suite runs against the real project, in two halves.

`test/rls.live.test.ts` covers the tables: two throwaway projects, three real auth users, a
recording seeded in each, then every table read as each user with `SET ROLE authenticated` and a
`request.jwt.claims` subject. A member sees their own site and nothing of the other, a signed-in
non-member sees zero rows, an anonymous visitor sees zero rows, a member's `INSERT` is refused.

`test/storage.live.test.ts` covers the bytes, and takes the path a browser actually takes: it signs
in with `SUPABASE_PUBLISHABLE_KEY` to get a real session, mints a signed URL, and streams it. A
member gets their clip's bytes; the same member is refused a URL for another project's clip; a
non-member and an anonymous visitor are refused; listing shows only reachable folders.

`test/access.live.test.ts` covers `grant-access` end to end: it grants a fresh account, signs in
with the password it handed back, and reads the project's recordings and events through the
publishable key. It also asserts a second run changes nothing and that an unknown project is
refused.

All three delete their fixtures and auth users afterwards. None is in CI, because they need live
credentials — run them before deploying a policy or access change.

## Verify

```bash
npm run typecheck
npm test
npm run audit:comments
```

## Known limits of this slice

- HTTP only. The connection file carries no certificate, which the Axis spec allows for
  development and warns against for production. TLS is the next slice.
- No content encryption (`WantEncryption: false`).
- Supabase Storage on the free plan caps a single upload at 50 MB. Long clips will 500 until the
  plan or the upload path changes.
- **The analysis has never seen real construction footage.** The whole path has run against the
  real OpenAI API and real Supabase, but only on synthetic test-pattern video, where the correct
  answer is an empty event list. Whether the events are any good is still unknown.
- `CD_PUBLIC_URL` is the address the W800 is handed after auth. If it is stale, the offload
  authenticates and then times out reaching storage.
- Analysis runs in the intake process. A long clip competes with uploads for CPU. If that starts
  to hurt, the claim is already built to let a second process take over.
- Zone is whatever the model can read off a sign in frame, and usually nothing. There is no zone
  model in this repo yet.
