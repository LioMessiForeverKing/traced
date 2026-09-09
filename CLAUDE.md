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
  we mint into a connection file. The only external key is `ANTHROPIC_API_KEY`.
- **`src/stores/supabase.ts` is unproven.** The tests exercise an in-memory store, so no Drizzle
  query or bucket upload here has ever run against the real project. Treat the first real
  `npm run fake-w800` as the actual test of it.
- **RLS is on with no policies**, so only the service role reads anything. Correct today; it blocks
  everything browser-facing until the policies are designed.
- Nothing has touched real hardware. Every protocol detail was read from the specification at
  `github.com/AxisCommunications/body-worn-integration-api`.

## Before opening a PR

```bash
npm run typecheck && npm test && npm run audit:comments
```
