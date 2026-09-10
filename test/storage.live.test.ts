import { randomUUID } from "node:crypto";
import { type SupabaseClient, createClient } from "@supabase/supabase-js";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

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

const stamp = `rls-storage-${randomUUID()}`;
const prefix = `${stamp}%`;
const clipBytes = new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7]);

const db = postgres(databaseUrl, { prepare: false });
const admin = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false } });

const site = { a: "", b: "" };
const account: Record<string, { id: string; email: string; password: string }> = {};
const clipPath = { a: "", b: "" };

async function createAccount(labelled: string) {
  const email = `${stamp}-${labelled}@traced.invalid`;
  const password = randomUUID();
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw error;
  account[labelled] = { id: data.user.id, email, password };
}

async function signIn(labelled: string): Promise<SupabaseClient> {
  const client = createClient(supabaseUrl, publishableKey, { auth: { persistSession: false } });
  const { error } = await client.auth.signInWithPassword({
    email: account[labelled].email,
    password: account[labelled].password,
  });
  if (error) throw error;
  return client;
}

async function seedSite(name: "a" | "b"): Promise<void> {
  const [project] = await db`insert into projects (name) values (${`${stamp} ${name}`}) returning id`;
  site[name] = project.id as string;
  const recording = `${stamp}-rec-${name}`;
  await db`
    insert into recordings (name, project_id, status, meta)
    values (${recording}, ${site[name]}, 'complete', '{}'::jsonb)
  `;
  const path = `${recording}/clip.mp4`;
  clipPath[name] = path;
  const { error } = await admin.storage.from(bucket).upload(path, clipBytes, {
    contentType: "video/mp4",
    upsert: true,
  });
  if (error) throw error;
  await db`
    insert into recording_objects (recording_name, name, kind, storage_path, meta)
    values (${recording}, 'clip.mp4', 'clip', ${path}, '{}'::jsonb)
  `;
}

beforeAll(async () => {
  await createAccount("alice");
  await createAccount("viewer");
  await createAccount("outsider");
  await seedSite("a");
  await seedSite("b");
  await db`
    insert into project_members (project_id, user_id, role)
    values (${site.a}, ${account.alice.id}, 'member'), (${site.a}, ${account.viewer.id}, 'viewer')
  `;
});

afterAll(async () => {
  await admin.storage.from(bucket).remove([clipPath.a, clipPath.b].filter(Boolean));
  await db`delete from recordings where name like ${prefix}`;
  await db`delete from project_members where project_id in (${site.a}, ${site.b})`;
  await db`delete from projects where name like ${prefix}`;
  for (const entry of Object.values(account)) await admin.auth.admin.deleteUser(entry.id);
  await db.end();
});

describe("recordings bucket", () => {
  it("lets a member sign a url for their own clip and stream the bytes", async () => {
    const alice = await signIn("alice");
    const { data, error } = await alice.storage.from(bucket).createSignedUrl(clipPath.a, 60);
    expect(error).toBeNull();
    expect(data?.signedUrl).toBeTruthy();

    const response = await fetch(data!.signedUrl);
    expect(response.status).toBe(200);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(clipBytes);
  });

  it("refuses a member a url for another project's clip", async () => {
    const alice = await signIn("alice");
    const { data, error } = await alice.storage.from(bucket).createSignedUrl(clipPath.b, 60);
    expect(data).toBeNull();
    expect(error).toBeTruthy();
  });

  it("refuses an insurance viewer of the very same project", async () => {
    const viewer = await signIn("viewer");
    const { data, error } = await viewer.storage.from(bucket).createSignedUrl(clipPath.a, 60);
    expect(data).toBeNull();
    expect(error).toBeTruthy();
  });

  it("refuses a signed-in non-member", async () => {
    const outsider = await signIn("outsider");
    const { data, error } = await outsider.storage.from(bucket).createSignedUrl(clipPath.a, 60);
    expect(data).toBeNull();
    expect(error).toBeTruthy();
  });

  it("refuses an anonymous visitor", async () => {
    const anon = createClient(supabaseUrl, publishableKey, { auth: { persistSession: false } });
    const { data, error } = await anon.storage.from(bucket).createSignedUrl(clipPath.a, 60);
    expect(data).toBeNull();
    expect(error).toBeTruthy();
  });

  it("lists only the folders of recordings the member can reach", async () => {
    const alice = await signIn("alice");
    const { data } = await alice.storage.from(bucket).list("");
    const names = (data ?? []).map((entry) => entry.name);
    expect(names).toContain(`${stamp}-rec-a`);
    expect(names).not.toContain(`${stamp}-rec-b`);
  });
});
