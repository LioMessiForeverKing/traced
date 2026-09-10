import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { grantAccess } from "../src/access.js";
import { loadEnv } from "../src/env.js";

const bucket = process.env.RECORDINGS_BUCKET ?? "recordings";

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`test:rls runs against the real project and needs ${name}`);
  return value;
}

const databaseUrl = required("DATABASE_URL");
const supabaseUrl = required("SUPABASE_URL");
const serviceRoleKey = required("SUPABASE_SERVICE_ROLE_KEY");
const publishableKey = required("SUPABASE_PUBLISHABLE_KEY");

const env = loadEnv();
const stamp = `rls-grant-${randomUUID()}`;
const prefix = `${stamp}%`;
const email = `${stamp}@traced.invalid`;
const recording = `${stamp}-rec`;

const db = postgres(databaseUrl, { prepare: false });
const admin = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false } });

let projectId = "";
let grantedUserId = "";

beforeAll(async () => {
  const [project] = await db`insert into projects (name) values (${`${stamp} site`}) returning id`;
  projectId = project.id as string;
  await db`
    insert into recordings (name, project_id, status, meta)
    values (${recording}, ${projectId}, 'complete', '{}'::jsonb)
  `;
  await db`
    insert into recording_events (recording_name, offset_seconds, description, confidence, frame_offsets)
    values (${recording}, 4.0, 'rebar tied at the north face', 0.87, array[4.0])
  `;
});

afterAll(async () => {
  await db`delete from recordings where name like ${prefix}`;
  await db`delete from project_members where project_id = ${projectId}`;
  await db`delete from projects where name like ${prefix}`;
  if (grantedUserId) await admin.auth.admin.deleteUser(grantedUserId);
  await db.end();
});

describe("grant-access", () => {
  it("creates the account, joins the project, and hands back a usable password", async () => {
    const grant = await grantAccess(env, { email, projectId });
    grantedUserId = grant.user.id;

    expect(grant.project.id).toBe(projectId);
    expect(grant.user.created).toBe(true);
    expect(grant.membershipCreated).toBe(true);
    expect(grant.password).toBeTruthy();

    const client = createClient(supabaseUrl, publishableKey, { auth: { persistSession: false } });
    const { error: signInError } = await client.auth.signInWithPassword({
      email,
      password: grant.password!,
    });
    expect(signInError).toBeNull();

    const { data: rows } = await client.from("recordings").select("name");
    expect((rows ?? []).map((row) => row.name)).toEqual([recording]);

    const { data: events } = await client.from("recording_events").select("description");
    expect((events ?? []).map((row) => row.description)).toEqual(["rebar tied at the north face"]);
  });

  it("is safe to run twice", async () => {
    const again = await grantAccess(env, { email, projectId });
    expect(again.user.created).toBe(false);
    expect(again.membershipCreated).toBe(false);
    expect(again.password).toBeNull();
  });

  it("refuses a project that does not exist", async () => {
    await expect(grantAccess(env, { email, projectId: randomUUID() })).rejects.toThrow(/no project/);
  });
});
