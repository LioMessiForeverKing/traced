# CLAUDE.md

Project memory for Traced. An index, not a knowledge base — it points, it does not explain.
Code rules live in `AGENTS.md`. Read both before the first edit.

## What this repo is

The **intake**: the server an AXIS W800 system controller pushes body worn recordings to after a
camera docks. It is not the dashboard, and it will never run on Vercel — a clip arrives as one
HTTP PUT of hundreds of megabytes, which serverless cannot accept.

The dashboard is a **separate repo that does not exist yet**, and that one is a Vercel project.
Video never passes through it; the browser streams from Supabase Storage with a signed URL.

## Keep the timeline current

```
~/Library/Mobile Documents/com~apple~CloudDocs/Obsidian/AyensLife/Projects/Traced/Timeline.md
```

Also reachable through the `obsidian` MCP server, vault id `life`, at
`Projects/Traced/Timeline.md`.

**Read it at the start of a session and update it at the end of any session that ships something,
changes a decision, or unblocks something.** Not batched, not reconstructed a week later. It holds
what is done, what is next, where each piece deploys, and every decision with its reason.

If the timeline disagrees with the code, the code is right and the note is stale. Fix the note.

The wider picture is in `Projects/Traced.md`; the design language with real token values is in
`Design/Traced Design.md`.

## Standing facts

- **There is no Axis API key.** We are the server. The W800 authenticates to *us* with credentials
  we mint into a connection file. The only external key is `OPENAI_API_KEY`.
- **`src/stores/supabase.ts` has run against the real project** (2026-09-09). A full
  `npm run fake-w800` offload wrote every row and uploaded both objects to Storage, and the
  analysis claim, the signed clip URL and the event writeback all executed against real Postgres.
  The tests still drive an in-memory store, so **CI still proves nothing about this file** — but it
  is no longer untried code.
- **A failed analysis retries three times, ten minutes apart**, counted in
  `recordings.analysis_attempts`. The clip is rarely what failed; an outage marks a recording failed
  while its footage is intact, and before this that lost a shift permanently. **A failure that cannot come out
  differently skips the retries**: `frames.ts` throws `UnanalysableRecording` and `loop.ts` writes
  `analysis_status = 'refused'`, which the claim query never picks up. Only two outcomes qualify, and
  they qualify because a short read cannot produce them: frames still arriving at the decode ceiling
  (a truncated transfer yields fewer, never more) and written frames with no timing this build prints
  (a property of the binary). Everything else retries. Measured 2026-09-15, and the reason the bar is
  this narrow: a reset MP4 transfer prints no `Input #0`, exactly like a Storage `503`; `Duration:
  N/A` is not a property of the recording, since a *healthy* MPEG-TS over HTTP reports it; and a
  reset MPEG-TS transfer **exits 0**, so even a clean exit does not prove the bytes arrived. Nothing
  moves a `refused` row back by itself.
- **Frame sampling covers the whole clip, not just its start.** Scene detection alone finds nothing
  in body worn footage, which never cuts — at the default threshold any clip, 17 seconds or two
  hours, yielded exactly one frame. `frames.ts` now also takes a frame every
  `max(1s, duration/maxFrames, duration/399)` seconds, holds scene changes at least a quarter of
  that apart, and spreads the budget over the clip's own span — so no threshold or budget can ask
  ffmpeg for more than the 400 frames it decodes and leave the tail of a shift unsampled. Proven
  2026-09-10: a 10-minute continuous clip went from 1 frame to 24 spanning 0–575s.
- **`src/analysis/extractor.ts` has run against the real OpenAI API**, end to end through the whole
  slice, on 2026-09-09. What it has never seen is real construction footage — only synthetic test
  video, where an empty event list is the right answer. The tests still inject a stub on purpose;
  a test suite must not spend money.
- **RLS is on, and every table has one `SELECT` policy** for `authenticated`, gated on membership
  of the row's project. `project_members.role` is `member` or `viewer`: a member is the contractor
  and reads everything, a viewer is the insurance side and reads `projects`, `recordings` and
  `recording_events` only — never the clip bytes, the workers or the roster. The member-only
  predicate is the default, so a table nobody widened shows a viewer too little rather than too
  much. There are no write policies: the browser reads, the intake writes with the service-role
  key. Proven 2026-09-10 against the real project by `npm run test:rls`, which is not in CI
  because it needs live credentials.
- **The browser mints its own signed clip URL.** `storage.objects` has a member-only `SELECT`
  policy keyed on the storage path, so the dashboard needs no server endpoint for playback and
  never holds the service-role key. Proven 2026-09-10 through a real signed-in session.
- **`PROJECT_ID` is configuration, not protocol.** The Axis wire format carries no notion of a
  site, so the intake stamps its own project onto every row it writes. One deployment, one W800,
  one site.
- Nothing has touched real hardware. Every protocol detail was read from the specification at
  `github.com/AxisCommunications/body-worn-integration-api`.

## Before opening a PR

```bash
npm run typecheck && npm test && npm run audit:comments
```
