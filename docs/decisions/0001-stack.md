# 0001 — A Node service, Supabase, Drizzle

**Status:** accepted · **Date:** 2026-09-08

## Context

The AXIS W800 system controller is the client. It pushes multi-hundred-megabyte video clips over
HTTP PUT to a server we run, after a camera docks. Whatever we build has to sit on the receiving
end of that, on a network the W800 can reach, and hold a connection open for the whole upload.

## Decision

A long-running Node service — Hono on `@hono/node-server` — as the content destination, with
Supabase for Postgres and Storage and Drizzle as the query layer. TypeScript strict throughout.

The house default is Next.js on Vercel. It is rejected here, for now, because a serverless
function cannot accept a multi-gigabyte request body, and the intake *is* the product. A UI,
when it earns one, is a separate deployable that reads the same tables.

Supabase Storage holds the bytes; Postgres holds everything an insurer would ask about — who, which
camera, when, where, what triggered it. Drizzle keeps the types generated from the schema.

## Consequences

- Two deployables the moment a UI arrives. Accepted; the intake has different scaling needs.
- The service needs a stable address and, in production, a certificate the W800 trusts.
- Row-level security is enabled on every table with no policies, so nothing but the service role
  can read them. Policies arrive with the first browser-facing surface.

## Rejected

- **Next.js route handlers as the intake.** Body size limits on serverless.
- **Letting the W800 write straight to Supabase Storage as a Swift store.** Storage is S3-shaped,
  not Swift-shaped, and we would lose the metadata headers.
- **Convex.** An experiment, not a default.
