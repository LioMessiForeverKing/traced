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
- **`src/analysis/extractor.ts` has run against the real OpenAI API**, end to end through the whole
  slice, on 2026-09-09. What it has never seen is real construction footage — only synthetic test
  video, where an empty event list is the right answer. The tests still inject a stub on purpose;
  a test suite must not spend money.
- **RLS is on, and every table now has one `SELECT` policy** for `authenticated`, gated on
  membership of the row's project. There are no write policies: the browser reads, the intake
  writes with the service-role key. Proven on 2026-09-09 against the real project by
  `npm run test:rls`, which is not in CI because it needs live credentials.
- **`PROJECT_ID` is configuration, not protocol.** The Axis wire format carries no notion of a
  site, so the intake stamps its own project onto every row it writes. One deployment, one W800,
  one site.
- Nothing has touched real hardware. Every protocol detail was read from the specification at
  `github.com/AxisCommunications/body-worn-integration-api`.

## Before opening a PR

```bash
npm run typecheck && npm test && npm run audit:comments
```
