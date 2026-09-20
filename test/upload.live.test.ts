import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type SupabaseClient, createClient } from "@supabase/supabase-js";
import ffmpegStatic from "ffmpeg-static";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { EventExtractor } from "../src/analysis/extractor.js";
import { sampleFrames } from "../src/analysis/frames.js";
import { type AnalysisLoop, createAnalysisLoop } from "../src/analysis/loop.js";
import { loadEnv } from "../src/env.js";
import { MAX_ANALYSIS_ATTEMPTS, RETRY_AFTER_MS } from "../src/store.js";
import { createSupabaseStore } from "../src/stores/supabase.js";
import { uploadRecordingName } from "../src/uploads.js";

const FFMPEG = ffmpegStatic as unknown as string;
const CLIP_SECONDS = 10;
const STARTED_AT = new Date("2026-09-20T07:15:00Z");
const AHEAD_OF_THE_UPLOAD = new Date("1999-01-01T00:00:00Z");
const FIRST_IN_THE_QUEUE = new Date("2000-01-01T00:00:00Z");
const DESCRIBED = "a worker carries a ladder across the slab";

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
const bucket = env.RECORDINGS_BUCKET;
const stamp = `rls-upload-${randomUUID()}`;

const db = postgres(databaseUrl, { prepare: false });
const service = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false } });

const account: Record<string, { id: string; email: string; password: string }> = {};
const session: Record<string, SupabaseClient> = {};
const recording = uploadRecordingName(STARTED_AT);
const clipPath = `${recording}/clip.mp4`;
const clipless = uploadRecordingName(new Date("2026-09-20T07:20:00Z"));
const decoy = `${randomUUID()}_B8A44F195EF7_20260920T071500Z`;
const camera = `${randomUUID()}_B8A44F195EF7_20260920T072000Z`;
const ours = [recording, clipless, decoy, camera];

let projectId = "";
let clipBytes = new Uint8Array(0);
let dir = "";
let framesSeen = 0;

const extractor: EventExtractor = {
  async extract(input) {
    framesSeen = input.frames.length;
    return [{ frameIndexes: [0], system: "Framing", zone: null, description: DESCRIBED, confidence: 0.82 }];
  },
};

function ffmpeg(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(FFMPEG, args);
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}`))));
  });
}

async function createAccount(labelled: string): Promise<void> {
  const email = `${stamp}-${labelled}@traced.invalid`;
  const password = randomUUID();
  const { data, error } = await service.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw error;
  account[labelled] = { id: data.user.id, email, password };
}

async function signIn(labelled: string): Promise<void> {
  const client = createClient(supabaseUrl, publishableKey, { auth: { persistSession: false } });
  const { error } = await client.auth.signInWithPassword({
    email: account[labelled]!.email,
    password: account[labelled]!.password,
  });
  if (error) throw error;
  session[labelled] = client;
}

function as(labelled: string): SupabaseClient {
  return session[labelled]!;
}

function recordingRow(overrides: Record<string, unknown> = {}) {
  return {
    name: recording,
    project_id: projectId,
    source: "upload",
    status: "uploading",
    start_time: STARTED_AT.toISOString(),
    completed_at: FIRST_IN_THE_QUEUE.toISOString(),
    meta: {},
    ...overrides,
  };
}

function objectRow(overrides: Record<string, unknown> = {}) {
  return {
    recording_name: recording,
    name: "clip.mp4",
    kind: "clip",
    storage_path: clipPath,
    content_type: "video/mp4",
    size_bytes: clipBytes.length,
    meta: {},
    ...overrides,
  };
}

function analyser(): AnalysisLoop {
  return createAnalysisLoop({
    store: createSupabaseStore(env),
    extractor,
    sampler: sampleFrames,
    maxFrames: 8,
    sceneThreshold: 0.4,
    frameWidth: 320,
    pollMs: 60_000,
    log: () => {},
  });
}

function everythingElse() {
  return db`
    select name, status, analysis_status, analysis_attempts, analysed_at
    from recordings where not (name = any(${ours})) order by name
  `;
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "traced-upload-test-"));
  const file = join(dir, "clip.mp4");
  await ffmpeg([
    "-hide_banner",
    "-loglevel",
    "error",
    "-f",
    "lavfi",
    "-i",
    `smptebars=duration=${CLIP_SECONDS}:size=160x120:rate=5`,
    "-pix_fmt",
    "yuv420p",
    file,
  ]);
  clipBytes = new Uint8Array(await readFile(file));

  for (const labelled of ["boss", "alice", "viewer"]) await createAccount(labelled);

  const [project] = await db`insert into projects (name) values (${`${stamp} site`}) returning id`;
  projectId = project!.id as string;
  await db`
    insert into project_members (project_id, user_id, role)
    values (${projectId}, ${account.alice!.id}, 'member'), (${projectId}, ${account.viewer!.id}, 'viewer')
  `;
  await db`insert into platform_admins (user_id) values (${account.boss!.id})`;
  for (const labelled of ["boss", "alice", "viewer"]) await signIn(labelled);
  await db`
    insert into recordings (name, project_id, status, completed_at, meta)
    values (${decoy}, ${projectId}, 'complete', ${AHEAD_OF_THE_UPLOAD}, '{}'::jsonb)
  `;
  await db`
    insert into recordings (name, project_id, status, meta)
    values (${camera}, ${projectId}, 'uploading', '{}'::jsonb)
  `;
}, 120_000);

afterAll(async () => {
  await service.storage.from(bucket).remove([clipPath, `${recording}/member-attempt.mp4`]);
  if (account.boss) await db`delete from platform_admins where user_id = ${account.boss.id}`;
  if (projectId) {
    await db`delete from recordings where project_id = ${projectId}`;
    await db`delete from project_members where project_id = ${projectId}`;
  }
  await db`delete from projects where name like ${`${stamp}%`}`;
  for (const entry of Object.values(account)) await service.auth.admin.deleteUser(entry.id);
  await rm(dir, { recursive: true, force: true });
  await db.end();
});

describe("an admin uploading a clip", () => {
  it("refuses the bytes while no row says an upload is in progress", async () => {
    const boss = as("boss");
    const { data, error } = await boss.storage.from(bucket).createSignedUploadUrl(clipPath);
    expect(data).toBeNull();
    expect(error).toBeTruthy();
  });

  it("inserts the recording as uploading, and refuses one born any other way", async () => {
    const boss = as("boss");

    const bornComplete = await boss
      .from("recordings")
      .insert(recordingRow({ name: uploadRecordingName(STARTED_AT), status: "complete" }));
    expect(bornComplete.error).toBeTruthy();

    const asAxis = await boss
      .from("recordings")
      .insert(recordingRow({ name: uploadRecordingName(STARTED_AT), source: "axis" }));
    expect(asAxis.error).toBeTruthy();

    const unusedCameraName = `${randomUUID()}_B8A44F195EF7_20260920T071500Z`;
    const asCameraName = await boss.from("recordings").insert(recordingRow({ name: unusedCameraName }));
    expect(asCameraName.error).toBeTruthy();

    const bornDone = await boss
      .from("recordings")
      .insert(recordingRow({ name: uploadRecordingName(STARTED_AT), analysis_status: "done" }));
    expect(bornDone.error).toBeTruthy();

    const bornSpent = await boss
      .from("recordings")
      .insert(recordingRow({ name: uploadRecordingName(STARTED_AT), analysis_attempts: 3 }));
    expect(bornSpent.error).toBeTruthy();

    const bornUnqueued = await boss
      .from("recordings")
      .insert(recordingRow({ name: uploadRecordingName(STARTED_AT), completed_at: null }));
    expect(bornUnqueued.error).toBeTruthy();

    const { error } = await boss.from("recordings").insert(recordingRow());
    expect(error).toBeNull();
  });

  it("refuses a member and a viewer the recording insert the admin was allowed", async () => {
    for (const labelled of ["alice", "viewer"]) {
      const client = as(labelled);
      const { error } = await client
        .from("recordings")
        .insert(recordingRow({ name: uploadRecordingName(STARTED_AT) }));
      expect(error).toBeTruthy();
    }
  });

  it("puts the bytes under the recording's own folder with a signed upload URL", async () => {
    const boss = as("boss");
    const { data, error } = await boss.storage.from(bucket).createSignedUploadUrl(clipPath);
    expect(error).toBeNull();
    expect(data?.token).toBeTruthy();

    const put = await boss.storage
      .from(bucket)
      .uploadToSignedUrl(clipPath, data!.token, clipBytes, { contentType: "video/mp4" });
    expect(put.error).toBeNull();

    const { data: listed } = await service.storage.from(bucket).list(recording);
    expect((listed ?? []).map((entry) => entry.name)).toEqual(["clip.mp4"]);
  });

  it("refuses an admin a folder belonging to a camera's recording", async () => {
    const boss = as("boss");
    const { data, error } = await boss.storage.from(bucket).createSignedUploadUrl(`${camera}/clip.mp4`);
    expect(data).toBeNull();
    expect(error).toBeTruthy();
  });

  it("refuses the same upload to a member and to an insurance viewer", async () => {
    for (const labelled of ["alice", "viewer"]) {
      const client = as(labelled);
      const { data, error } = await client.storage
        .from(bucket)
        .createSignedUploadUrl(`${recording}/member-attempt.mp4`);
      expect(data).toBeNull();
      expect(error).toBeTruthy();
    }
  });

  it("inserts the object row, and refuses one pointing anywhere else", async () => {
    const boss = as("boss");

    const elsewhere = await boss
      .from("recording_objects")
      .insert(objectRow({ storage_path: `${camera}/clip.mp4` }));
    expect(elsewhere.error).toBeTruthy();

    const ontoACamera = await boss
      .from("recording_objects")
      .insert(objectRow({ recording_name: camera, storage_path: `${camera}/clip.mp4` }));
    expect(ontoACamera.error).toBeTruthy();

    const { error } = await boss.from("recording_objects").insert(objectRow());
    expect(error).toBeNull();
  });

  it("refuses a member and a viewer an object row on the admin's upload", async () => {
    for (const labelled of ["alice", "viewer"]) {
      const client = as(labelled);
      const { error } = await client
        .from("recording_objects")
        .insert(objectRow({ name: "second.mp4", storage_path: `${recording}/second.mp4` }));
      expect(error).toBeTruthy();
    }

    const rows = await db`select name from recording_objects where recording_name = ${recording}`;
    expect(rows.map((row) => row.name)).toEqual(["clip.mp4"]);
  });

  it("is passed over by the analyser for as long as the clip is still arriving", async () => {
    const before = await everythingElse();
    expect(await analyser().runOnce()).toBe(decoy);
    expect(await everythingElse()).toEqual(before);

    const [row] = await db`
      select status, analysis_status, analysis_attempts from recordings where name = ${recording}
    `;
    expect(row!.status).toBe("uploading");
    expect(row!.analysis_status).toBe("pending");
    expect(row!.analysis_attempts).toBe(0);
  }, 120_000);

  it("refuses the flip until a clip has actually landed", async () => {
    const boss = as("boss");
    const born = await boss.from("recordings").insert(recordingRow({ name: clipless }));
    expect(born.error).toBeNull();

    const early = await boss
      .from("recordings")
      .update({ status: "complete" })
      .eq("name", clipless)
      .select();
    expect(early.error?.message).toMatch(/row-level security/);

    const [row] = await db`select status from recordings where name = ${clipless}`;
    expect(row!.status).toBe("uploading");
  });

  it("refuses the admin every column of the flip but the status", async () => {
    const boss = as("boss");

    const withMeta = await boss
      .from("recordings")
      .update({ status: "complete", meta: { tampered: true } })
      .eq("name", recording)
      .select();
    expect(withMeta.error?.message).toMatch(/permission denied/);

    const withAnalysis = await boss
      .from("recordings")
      .update({ status: "complete", analysis_status: "done" })
      .eq("name", recording)
      .select();
    expect(withAnalysis.error?.message).toMatch(/permission denied/);

    const toAnythingElse = await boss
      .from("recordings")
      .update({ status: "tampered" })
      .eq("name", recording)
      .select();
    expect(toAnythingElse.error?.message).toMatch(/row-level security/);

    const [row] = await db`select status, meta from recordings where name = ${recording}`;
    expect(row!.status).toBe("uploading");
    expect(row!.meta).toEqual({});
  });

  it("refuses the flip on a camera's recording, and to a member and a viewer", async () => {
    const boss = as("boss");
    const onACamera = await boss
      .from("recordings")
      .update({ status: "complete" })
      .eq("name", camera)
      .select();
    expect(onACamera.error).toBeNull();
    expect(onACamera.data).toEqual([]);

    for (const labelled of ["alice", "viewer"]) {
      const client = as(labelled);
      const refused = await client
        .from("recordings")
        .update({ status: "complete" })
        .eq("name", recording)
        .select();
      expect(refused.error).toBeNull();
      expect(refused.data).toEqual([]);
    }

    const [row] = await db`select status from recordings where name = ${camera}`;
    expect(row!.status).toBe("uploading");
  });

  it("lets the admin move their own upload to complete once the clip is there", async () => {
    const boss = as("boss");
    const { data, error } = await boss
      .from("recordings")
      .update({ status: "complete" })
      .eq("name", recording)
      .select("name, status");
    expect(error).toBeNull();
    expect(data).toEqual([{ name: recording, status: "complete" }]);
  });

  it("shuts the folder and the row the moment the clip has landed", async () => {
    const boss = as("boss");

    const moreBytes = await boss.storage.from(bucket).createSignedUploadUrl(`${recording}/second.mp4`);
    expect(moreBytes.data).toBeNull();
    expect(moreBytes.error).toBeTruthy();

    const secondClip = await boss
      .from("recording_objects")
      .insert(objectRow({ name: "second.mp4", storage_path: `${recording}/second.mp4` }));
    expect(secondClip.error).toBeTruthy();

    const backToUploading = await boss
      .from("recordings")
      .update({ status: "uploading" })
      .eq("name", recording)
      .select();
    expect(backToUploading.error).toBeNull();
    expect(backToUploading.data).toEqual([]);

    const deleted = await boss.from("recording_events").delete().eq("recording_name", recording).select();
    expect(deleted.data).toEqual([]);

    const overwritten = await boss.storage
      .from(bucket)
      .upload(clipPath, new Uint8Array([9, 9, 9]), { contentType: "video/mp4", upsert: true });
    expect(overwritten.error).toBeTruthy();

    const [row] = await db`select status from recordings where name = ${recording}`;
    expect(row!.status).toBe("complete");
    const rows = await db`select name from recording_objects where recording_name = ${recording}`;
    expect(rows.map((entry) => entry.name)).toEqual(["clip.mp4"]);
  });

  it("is claimed by the unmodified analyser and becomes events", async () => {
    const retryFrom = new Date(Date.now() - RETRY_AFTER_MS);
    const [next] = await db`
      select name from recordings
      where status = 'complete'
        and (analysis_status = 'pending'
          or (analysis_status = 'failed'
            and analysis_attempts < ${MAX_ANALYSIS_ATTEMPTS}
            and analysed_at <= ${retryFrom}))
      order by completed_at asc
      limit 1
    `;
    expect(next?.name).toBe(recording);

    const before = await everythingElse();
    expect(await analyser().runOnce()).toBe(recording);
    expect(await everythingElse()).toEqual(before);

    expect(framesSeen).toBeGreaterThan(1);
    const [row] = await db`
      select analysis_status, analysis_error from recordings where name = ${recording}
    `;
    expect(row!.analysis_status).toBe("done");
    expect(row!.analysis_error).toBeNull();

    const events = await db`
      select description, offset_seconds from recording_events where recording_name = ${recording}
    `;
    expect(events.map((event) => event.description)).toEqual([DESCRIBED]);
  }, 120_000);

  it("plays for a member of the project", async () => {
    const alice = as("alice");
    const { data: rows } = await alice.from("recordings").select("name, source");
    expect(rows).toContainEqual({ name: recording, source: "upload" });

    const { data, error } = await alice.storage.from(bucket).createSignedUrl(clipPath, 60);
    expect(error).toBeNull();

    const response = await fetch(data!.signedUrl);
    expect(response.status).toBe(200);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(clipBytes);
  });

  it("reads to the insurer as a record with no footage behind it", async () => {
    const viewer = as("viewer");
    const { data: rows } = await viewer.from("recordings").select("name");
    expect((rows ?? []).map((row) => row.name)).toContain(recording);

    const { data: events } = await viewer
      .from("recording_events")
      .select("description")
      .eq("recording_name", recording);
    expect((events ?? []).map((row) => row.description)).toEqual([DESCRIBED]);

    const { data: objects } = await viewer
      .from("recording_objects")
      .select("storage_path")
      .eq("recording_name", recording);
    expect(objects ?? []).toEqual([]);

    const signed = await viewer.storage.from(bucket).createSignedUrl(clipPath, 60);
    expect(signed.data).toBeNull();
    expect(signed.error).toBeTruthy();
  });
});
