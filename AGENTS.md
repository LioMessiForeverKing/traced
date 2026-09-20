# AGENTS.md

The contract for anyone — person or agent — writing code in this repository.
Read it before the first edit. It is short on purpose.

## What this project is

Body worn cameras on construction workers, offloading to a content destination we own, so that a
build becomes an evidence record an insurer can price against. This repo is the content
destination and everything downstream of it. The insurance thesis lives in Ayen's vault, not here.

Do not infer scope from folder names. If a ticket does not say it, it is not in scope.

## The loop

1. Branch from `main`, one branch per slice, in its own worktree.
2. Commit as often as you like.
3. Open the PR. Description says *why*; the diff says *how*.
4. Squash merge, delete the branch, remove the worktree — in one sitting.

`main` is protected. Nothing reaches it except through a pull request.

## Pull requests

- **Under 2,000 lines changed**, additions plus deletions, excluding lockfiles.
- **One vertical slice** — the change and its tests together. Never "tests in a follow-up".
- **Refactor and behaviour change never share a PR.** The refactor goes first.
- **Title** is imperative, under 50 characters, no full stop.
- Anything the change made stale — this file, the README, `docs/` — is fixed in the same PR.
- Person-verified and CI-verified are separate claims. Say which is which.

## Code

**TypeScript** — `strict: true`. No `any`; use `unknown` and narrow. Types come from the schema.

**Data** — Supabase, with Drizzle over raw queries. RLS on every table. The service-role key
never leaves the server. Config lives in `.env.local`, never in the repo.

**Access** — policies live in `src/db/schema.ts` as `pgPolicy`, not in hand-written SQL, so the
schema stays the single source of truth. Every table gets one `SELECT` policy for `authenticated`,
gated on project membership. The only writes a browser may make are the three `INSERT` policies of
the admin upload path; a member and a viewer write nothing anywhere, and no table has an `UPDATE` or
`DELETE` policy, so evidence can be added by an admin and altered by nobody. `npm run test:rls`
proves them against the real project and is the gate before any policy change ships.

`project_members.role` is `member` or `viewer` — the contractor and the insurance side. A new
table gets `memberOf`, the member-only predicate, and only a deliberate decision widens it to
`accessTo`. That direction is the safety property: a table nobody thought about shows an insurer
too little, never too much.

A platform admin is a row in `platform_admins`, keyed on `auth.users` and belonging to no project,
because an admin is above projects rather than a member of each. `public.is_admin()` is `or`-ed
into all four access functions, so every policy inherits an admin without a single policy being
rewritten — **which means `is_project_member` and `is_recording_member` now return true for someone
holding no `project_members` row at all.** Read those four as *may act as a member here*, never as
a fact about membership; `project_members` is the only thing that answers that question. Granting
admin adds no membership row and removes none, so an admin may or may not also hold one. The admin
roster itself is readable only by an admin.

**Uploads** — `recordings.source` is `axis` or `upload` and defaults to `axis`, so the wire needed
no change to gain it. An uploaded recording is named by `src/uploads.ts` and always begins
`upload_`, which `parseRecordingName` can never return a match for; that disjointness is the whole
reason a browser insert cannot land on a camera's row, and the policy enforces the prefix rather
than trusting it. The three inserts are narrowed the same way — `source = 'upload'` only, a row born
unanalysed because `analysis_status`, `analysis_attempts`, `analysis_error` and `analysed_at` belong
to the analyser and no `UPDATE` policy exists to correct a forged one, an object row only where
`storage_path` is exactly `<recording>/<name>` and the recording is an upload, and a bucket key only
under an `upload_` folder. That middle check is an `exists` inside the policy rather
than a sixth `SECURITY DEFINER` function, because a function answering *where a row came from* is
callable over PostgREST by anyone signed in and would answer about rows they cannot read — the five
that exist all answer about the caller instead, which is why they are safe to expose.

**The Axis protocol** — `src/axis/` is a module, not the spine. `src/axis/app.ts` is the wire and
the spec is `github.com/AxisCommunications/body-worn-integration-api`; change the wire only with the
spec open. `AXIS_ENABLED=false` starts the process without it, and without the four `CD_` values —
which is the point of the folder, because a clip can also arrive from a person with a file. Nothing
under `src/analysis/`, `src/db/` or `src/store.ts` may import from `src/axis/`; the store
implementations in `src/stores/` may, because they are where the wire meets Postgres.

**`docs/OPERATOR.md`** is the runbook for whoever has the hardware, and it is the one document in
this repo written for someone who is not changing the code. Every step in it that nobody has
actually performed carries a `⚠` and names the Axis document it came from. **Do not remove a `⚠`
until a person has done that step on real hardware and said so** — a runbook that overstates what
has been tried is worse than one with gaps, because the gaps are what an operator is asked to
report back. Anything that changes `CD_PUBLIC_URL`, the connection file, the wire or the env
contract makes that file stale and is fixed in the same PR.

**Analysis** — `src/analysis/` turns a complete recording into `recording_events`: `frames.ts`
samples on a duration-derived interval *plus* scene changes held a minimum distance apart, so a long
continuous recording is covered end to end rather than only at its start and no burst of scene
changes can crowd the interval out or exhaust the decode ceiling before the clip ends; it shells out
to `ffmpeg-static` and throws `UnanalysableRecording` for the two outcomes a truncated transfer
cannot produce — more frames than the decode ceiling, and frames with no timing this build prints;
`extractor.ts` is the only place that talks to OpenAI, `loop.ts` claims work and owns the retry
story, refusing those on the first attempt and retrying everything else. Nothing on the request path may call into it.

**Access** — `src/access.ts` is the only place that mints an account, a membership or a platform
admin. It uses the admin API and so needs the service-role key; nothing on the request path may
call it. `scripts/grant-access-args.ts` holds the CLI's argument rules and is unit-tested, so a
contradictory invocation is refused rather than half-parsed.

**Comments** — at most 5% of non-blank lines per file. No inline comments. No block over 3 lines.
`npm run audit:comments` must pass before a PR opens. It audits `src`, `scripts` and `test`; the
`drizzle/` folder is generated by drizzle-kit and carries its own markers.

## Verify before opening a PR

```bash
npm run typecheck && npm test && npm run audit:comments
```
