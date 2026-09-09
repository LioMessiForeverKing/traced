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

Tune it with `ANALYSIS_MAX_FRAMES`, `ANALYSIS_SCENE_THRESHOLD`, `ANALYSIS_FRAME_WIDTH` and
`ANALYSIS_POLL_MS`. Frame budget is the cost lever: frames dominate the bill. `OPENAI_MODEL`
defaults to `gpt-5.5`; drop to a smaller model for volume without touching code.

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
