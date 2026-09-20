# Traced

> ### 📕 Have the hardware? Read [**docs/OPERATOR.md**](docs/OPERATOR.md) first, not this file.
>
> That is the runbook: a W800, a docking station and a camera, from an empty Supabase project to a
> docked camera whose footage lands in the record. It opens with the one irreversible step in the
> procedure — **a body worn system locks to a content destination the moment it accepts one** — and
> this README does not. Getting the order wrong costs a factory reset of the entire system.
>
> This README is for the person changing the code.

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

`AXIS_ENABLED` mounts the Axis wire and defaults to `true`. Set it to `false` and the four `CD_`
values are not needed at all: the process runs the analyser alone, for clips that arrive some other
way than from a docked camera.

`PROJECT_ID` is the site this intake serves. One deployment serves one W800, which serves one
construction site, so the project is configuration rather than something the Axis protocol carries.
Migration `0003` seeds a `Bootstrap project` row at `00000000-0000-4000-8000-000000000001` for
local use; a real deployment inserts its own row in `projects` and points `PROJECT_ID` at it.

## Connect a W800

```bash
npm run connection-file           # writes traced-connection.json
```

Upload that file in AXIS Body Worn Manager. From then on, every docked camera offloads to this
service.

Do not do that from this section alone. **A body worn system locks to a content destination the
moment it accepts one**, and changing it afterwards means factory-resetting the whole system — so
the order of operations matters more than the command does. [docs/OPERATOR.md](docs/OPERATOR.md)
has that order, the network prerequisites the file's `CD_PUBLIC_URL` depends on, and what every
field in the file means.

The file carries `CD_PASSWORD` in clear text. Treat it as a secret.

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
When more frames are decoded than the budget allows, the cut is made purely on time — nothing knows
which frames were scene changes, so lowering the threshold is safe but changes little of what
reaches the model on a long recording. Making a scene change survive the cut is its own change.

That split matters because body worn footage is one continuous shot from a moving camera and never
cuts. Scene detection alone finds nothing in it: at the default threshold a 17-second clip yielded a
single frame, and so would a two-hour one.

Scene changes are held apart by a minimum spacing, so the second way of choosing frames can never
crowd out the first. Without it a camera swing produced a burst of near-identical frames that ate
the budget — and at a low enough threshold filled the decode ceiling before the clip ended, sampling
only the opening of the recording while the record claimed the whole shift. Both the interval and
that spacing are floored at `duration ÷ 399`, so the whole recording can never ask ffmpeg for more
than the 400 frames it will decode, whatever `ANALYSIS_SCENE_THRESHOLD` and `ANALYSIS_MAX_FRAMES`
are set to. The interval stops shrinking at `ANALYSIS_MAX_FRAMES` of 399, so no budget above 400
returns more than 400 frames.

Both floors are derived from the clip's duration, so **a recording that will not say how long it is
gets no record at all**. Without a duration there is no interval, scene detection alone finds
almost nothing in continuous footage, and the sampler would hand the extractor a single opening
frame to stand for a whole shift. It refuses instead, naming what ffmpeg said about the container.

A container that reports a length *shorter* than the truth is a milder problem than it sounds.
Both floors are computed from the too-small number, so the gates come out tighter than intended and
more frames are taken than the budget asked for — but ffmpeg still reads to the real end of the
file, and the budget is spent across the offsets that actually came back, so the record still covers
the whole shift. It only turns harmful when the gates are tight enough to hit the decode ceiling
before the clip ends, and that is the case the sampler refuses: it asks ffmpeg for one frame beyond
the ceiling, and receiving that frame is proof the clip was still going.

A container that *overstates* its length is not refused, and that is deliberate. It still covers the
whole video — the budget is spread over the offsets that came back, not over the declared length —
but it spreads it too thinly, so two hours declared on a ten-minute clip takes about three frames
for the whole thing. Refusing it was tried and reverted: the only signal available is the container
`Duration:`, which is the longest stream rather than the video, so an audio track running two
seconds past the picture — ordinary for a camera that records sound — looked identical to a clip
that stopped early, and intact shifts were failed for it. `ffmpeg-static` ships no `ffprobe`, so the
video stream's own length is not available to check against. The sparse-sampling consequence is
recorded in the timeline instead.

A failed analysis is retried. `analysis_attempts` counts every failure, and the claim query picks a
failed recording back up once ten minutes have passed, up to three attempts. That matters because
the clip is never the thing that failed — an OpenAI outage, a network blip or a timeout all mark a
recording failed while its footage sits intact in Storage, and before this a transient error lost a
shift permanently. After three attempts it stays failed rather than retrying a genuinely broken clip
forever.

A failure that cannot come out differently skips the retries entirely: the recording goes straight
to `refused`, which the claim query never picks up. Exactly two outcomes qualify, and what qualifies
them is that a short read cannot produce either: a clip still yielding frames at the decode ceiling,
where a truncated transfer would yield fewer and never more, and written frames carrying no timing
this ffmpeg build prints, which is a property of the binary rather than of the bytes. Re-reading
several hundred megabytes from Storage would reach the same verdict, so it does not.

Every other failure retries, and the bar is this narrow because the obvious wider ones were measured
and rejected. A reset MP4 transfer prints no `Input #0` at all — exactly what a Storage `503`
prints, so "could not open" cannot be terminal. `Duration: N/A` is not a property of the recording
either: a *healthy* MPEG-TS served over HTTP reports it, because the length is only knowable by
seeking to the end. And a reset MPEG-TS transfer exits `0`, so even a clean exit is not proof the
bytes arrived. Each of those would have discarded intact footage on a network blip. Nothing moves a
`refused` row back by itself; if the sampler's limits change, re-queue those rows by hand.

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

```bash
npm run grant-access -- insurance@example.com --role viewer
```

`--role viewer` grants the insurance side instead — the same account machinery, a different lens,
described below. Re-running with a different role changes it and says so: `previousRole` in the
output names the role it replaced, so nobody is quietly downgraded.

```bash
npm run grant-access -- ops@traced.example --admin
```

`--admin` grants the platform side: a row in `platform_admins`, because an admin reads every
project already and needs no membership to do it. It takes no project id and no `--role`, and
refuses both rather than guessing which one you meant. It never touches `project_members` — an
account that was already a member of a site keeps that row, so promoting somebody adds access and
does not quietly take away what they had.

It does not create projects. A new site is one `insert into projects (name) values ('...')`, and
its id is what you pass as the second argument.

## Who can read what

Every table has RLS on and one `SELECT` policy, `TO authenticated`, allowed to someone with a
`project_members` row for the project or to a platform admin. There are exactly three `INSERT`
policies, all of them a platform admin uploading a clip by hand, and no `UPDATE` or `DELETE` policy
anywhere for anyone. The intake holds the service-role key and writes everything a camera sends,
and the service role bypasses RLS. A dashboard bug can therefore add an upload and still cannot
alter evidence.

That row carries a `role`, and there are two of them. A `member` is the contractor and sees the
project whole. A `viewer` is the insurance side and sees the record of the work, not the site
around it. No row at all still means no rows at all — unless the account is a platform admin, which
is the third kind of login and the only one that is not a `project_members` row.

| | `member` | `viewer` | admin |
|---|---|---|---|
| `projects`, `recordings`, `recording_events` | own project | own project | every project |
| `camera_users`, `devices`, `bws_systems`, `project_members` | own project | no | every project |
| `recording_objects`, and the clip bytes | own project | no | every project |
| `platform_admins` | no | no | yes |

An insurer is buying the record, not the footage. Body worn video carries the faces and voices of
the workers wearing it, and an underwriter has no reason to watch a shift — so a viewer never
reaches `storage.objects` and cannot mint a signed URL at all. Releasing one clip for one disputed
claim is a call the contractor makes, and there is no mechanism for it yet. Worker names live in
`camera_users` and stay on the contractor's side for the same reason.

Workers wearing the cameras are `camera_users`, an Axis identity with no login and no relation to
`auth.users`.

`recording_objects` and `recording_events` carry no `project_id`. They reach a project through
their recording, so a clip can never disagree with the recording it belongs to.

The video itself is governed the same way. The `recordings` bucket is private and `storage.objects`
carries one `SELECT` policy for members, keyed on the storage path — an object lives at
`<recording_name>/<file>`, so `storage.foldername(name)` yields the recording and the same
`is_recording_member` answers for the bytes as for the rows. A member therefore mints their own
signed URL straight from the browser with the publishable key; there is no endpoint in between and
the service-role key never reaches the dashboard. Listing the bucket is filtered by the same policy,
so a member sees only their own recordings' folders.

All four policy predicates go through `SECURITY DEFINER` functions. A policy that queried
`project_members` directly would have its own subquery filtered by that table's policy, and
recurse. `is_project_member(uuid)` and `is_recording_member(text)` are true only for
`role = 'member'`; `has_project_access(uuid)` and `has_recording_access(text)` are true for either
role.

All four also begin `public.is_admin() or ...`, which is the whole of how an admin exists. There is
no admin policy anywhere: teaching those four functions teaches all nine policies at once, including
the `storage.objects` one, so nothing had to be rewritten and nothing can be left behind. The price
is that two of the four now have names that overstate what they check — `is_project_member` is true
for an admin who is a member of nothing. They answer *may this account act as a member here*, and
`project_members` remains the only answer to *is this account a member*. A platform admin is above
projects: the role is a `platform_admins` row and never a `project_members` one, so granting it puts
nobody on a roster — though an account promoted from member keeps the row it already had, because
`--admin` adds access and never removes it. A roster therefore answers *who is a member here*, and
never *who can read this*. `platform_admins` is readable only by an admin, so a contractor cannot
enumerate who is watching.

A clip does not have to come from a camera. `recordings.source` is `axis` or `upload` and defaults
to `axis`, so nothing the W800 sends changed, and an admin signed in to the browser may insert a
recording of their own, the object row for it, and the bytes at `<recording>/clip.mp4`. The
analyser never learned about any of this: it claims a complete recording out of Postgres and has
never cared how the row got there.

Three things keep that hole the size it is. The insert is admin-only, so a member and a viewer are
refused all three. The recording must be `source = 'upload'` and its name must begin `upload_` — a
shape `parseRecordingName` can never match, so the two namespaces cannot collide and a browser
insert can never land on a camera's recording. And the object row must point at
`<recording_name>/<name>` exactly, so it cannot claim footage that belongs to something else.
Nothing may be updated or deleted afterwards, by anyone, including the admin who uploaded it.

The split runs that way round deliberately. The member-only predicate is the one a table keeps by
default, so a table nobody has thought about shows a viewer nothing until someone widens it on
purpose — the failure is an insurer seeing too little, never too much. `storage.objects` needed no
edit at all to stay shut.

```bash
npm run test:rls
```

That suite runs against the real project, in four files.

`test/rls.live.test.ts` covers the tables: two throwaway projects, five real auth users, a
recording seeded in each, then every table read as each user with `SET ROLE authenticated` and a
`request.jwt.claims` subject. A member sees their own site and nothing of the other, a viewer of
the same site sees the record and none of the site around it, a signed-in non-member sees zero
rows, an anonymous visitor sees zero rows, a member's `INSERT` is refused. A platform admin sees
both sites whole while holding no membership row, sees the admin roster that everyone else is
refused, and is refused an `INSERT` into `recording_events` too — the three inserts an admin does
have are the upload path and nothing else.

`test/storage.live.test.ts` covers the bytes, and takes the path a browser actually takes: it signs
in with `SUPABASE_PUBLISHABLE_KEY` to get a real session, mints a signed URL, and streams it. A
member gets their clip's bytes; the same member is refused a URL for another project's clip; a
viewer of that very project is refused; a non-member and an anonymous visitor are refused; listing
shows only reachable folders. An admin streams a clip from a project they never joined, and lists
every folder.

`test/access.live.test.ts` covers `grant-access` end to end: it grants a fresh account, signs in
with the password it handed back, and reads the project's recordings and events through the
publishable key. It also asserts a second run changes nothing, that an unknown project is refused,
that a `viewer` grant reads the events but not `camera_users`, and that changing a role reports the
role it replaced. It also grants an admin, signs in as one, and reads a second project that account
was never added to.

`test/upload.live.test.ts` covers an admin putting a clip in without a camera, the whole way
through: it signs in with the publishable key, mints a signed upload URL, puts a real mp4 at
`<recording>/clip.mp4`, inserts the recording and its object row, and then runs the analyser
unchanged — which claims the row, pulls frames out of the uploaded bytes through a signed URL, and
writes `recording_events`. Around that it asserts the shape of the hole: the same upload is refused
to a member and to a viewer, a recording claiming `source = 'axis'` or a camera-shaped name is
refused, an object row pointing anywhere but its own folder is refused, an object row onto a
camera's recording is refused, and the admin who uploaded it cannot then update the row, delete the
events or overwrite the bytes. The member plays it; the insurer reads the record and its events and
is refused the object row and a signed URL.

All four delete their fixtures and auth users afterwards. None is in CI, because they need live
credentials — run them before deploying a policy or access change.

## Verify

```bash
npm run typecheck
npm test
npm run audit:comments
```

## Known limits of this slice

- HTTP only. The connection file carries no `HTTPSCertificate` field, which the Axis spec allows
  for development and warns against for production. TLS is the next slice. **Whether a shipping
  W800 will accept a plain-HTTP content destination at all is untested**, and if it refuses, TLS
  blocks every hardware test.
- No content encryption (`WantEncryption: false`).
- Supabase Storage on the free plan caps a single upload at 50 MB. Long clips will 500 until the
  plan or the upload path changes, and that now blocks the admin upload as well as the offload.
- An upload's recording row is complete before its object row exists, and the two inserts are
  adjacent calls from the browser. If the analyser claims in between — about a tenth of a second
  against a fifteen-second poll — the recording fails once with `has no clip to analyse` and the
  existing retry picks it up ten minutes later. Closing it needs an `UPDATE` policy to move the row
  to complete after the clip lands, which is a second hole in the write boundary and has not been
  opened for a window this size.
- **The analysis has never seen real construction footage.** The whole path has run against the
  real OpenAI API and real Supabase, but only on synthetic test-pattern video, where the correct
  answer is an empty event list. Whether the events are any good is still unknown.
- `CD_PUBLIC_URL` is the address the W800 is handed after auth. If it is stale, the offload
  authenticates and then times out reaching storage.
- Analysis runs in the intake process. A long clip competes with uploads for CPU. If that starts
  to hurt, the claim is already built to let a second process take over.
- Zone is whatever the model can read off a sign in frame, and usually nothing. There is no zone
  model in this repo yet.
