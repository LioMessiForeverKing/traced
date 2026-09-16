import { createClient } from "@supabase/supabase-js";
import { and, asc, eq, inArray, lt, lte, or, sql } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import { createDb } from "../db/client.js";
import { bwsSystems, cameraUsers, devices, recordingEvents, recordingObjects, recordings } from "../db/schema.js";
import type { Env } from "../env.js";
import {
  MAX_ANALYSIS_ATTEMPTS,
  RETRY_AFTER_MS,
  type AnalysisClaim,
  type AnalysisEvent,
  type Meta,
  type PutObjectInput,
  type RecordingName,
  type RecordingStore,
} from "../store.js";
import { metaTime, recordingStatus } from "../swift.js";

function activeFlag(meta: Meta): boolean | null {
  const value = meta.active?.toLowerCase();
  if (value === "true") return true;
  if (value === "false") return false;
  return null;
}

function mergedMeta(column: AnyPgColumn, meta: Meta) {
  return sql`${column} || ${JSON.stringify(meta)}::jsonb`;
}

const CLIP_URL_TTL_SECONDS = 60 * 60;

export function createSupabaseStore(env: Env): RecordingStore {
  const db = createDb(env.DATABASE_URL);
  const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  });
  const bucket = supabase.storage.from(env.RECORDINGS_BUCKET);

  return {
    async upsertSystem(id, meta) {
      const values = {
        id,
        projectId: env.PROJECT_ID,
        connectionId: meta.connectionid ?? null,
        systemName: meta.systemname ?? null,
        meta,
      };
      await db
        .insert(bwsSystems)
        .values(values)
        .onConflictDoUpdate({
          target: bwsSystems.id,
          set: { ...values, meta: mergedMeta(bwsSystems.meta, meta), updatedAt: new Date() },
        });
    },

    async upsertCameraUser(id, meta) {
      const values = {
        id,
        projectId: env.PROJECT_ID,
        name: meta.name ?? null,
        userId: meta.userid ?? null,
        active: activeFlag(meta),
        meta,
      };
      await db
        .insert(cameraUsers)
        .values(values)
        .onConflictDoUpdate({
          target: cameraUsers.id,
          set: { ...values, meta: mergedMeta(cameraUsers.meta, meta), updatedAt: new Date() },
        });
    },

    async upsertDevice(serial, meta) {
      const values = {
        serial,
        projectId: env.PROJECT_ID,
        name: meta.name ?? null,
        model: meta.model ?? null,
        active: activeFlag(meta),
        meta,
      };
      await db
        .insert(devices)
        .values(values)
        .onConflictDoUpdate({
          target: devices.serial,
          set: { ...values, meta: mergedMeta(devices.meta, meta), updatedAt: new Date() },
        });
    },

    async createRecording(recording: RecordingName, meta: Meta) {
      const status = recordingStatus(meta, recording.rejected) ?? "transferring";
      const inserted = await db
        .insert(recordings)
        .values({
          name: recording.name,
          projectId: env.PROJECT_ID,
          userId: recording.userId,
          deviceSerial: recording.deviceSerial,
          status,
          triggerOn: meta.triggeron ?? null,
          triggerOff: meta.triggeroff ?? null,
          triggerOnTime: metaTime(meta, "triggerontime") ?? recording.triggerOnTime,
          triggerOffTime: metaTime(meta, "triggerofftime"),
          startTime: metaTime(meta, "starttime"),
          stopTime: metaTime(meta, "stoptime"),
          completedAt: status === "complete" ? new Date() : null,
          meta,
        })
        .onConflictDoNothing()
        .returning({ name: recordings.name });
      if (inserted.length > 0) return "created";
      await this.updateRecording(recording.name, meta);
      return "existing";
    },

    async updateRecording(name, meta) {
      const status = recordingStatus(meta, false);
      const rows = await db
        .update(recordings)
        .set({
          meta: mergedMeta(recordings.meta, meta),
          updatedAt: new Date(),
          ...(status ? { status } : {}),
          ...(status === "complete" ? { completedAt: sql`coalesce(${recordings.completedAt}, now())` } : {}),
          ...(meta.triggeroff ? { triggerOff: meta.triggeroff } : {}),
          ...(metaTime(meta, "triggerofftime") ? { triggerOffTime: metaTime(meta, "triggerofftime") } : {}),
          ...(metaTime(meta, "stoptime") ? { stopTime: metaTime(meta, "stoptime") } : {}),
        })
        .where(eq(recordings.name, name))
        .returning({ name: recordings.name });
      return rows.length > 0;
    },

    async putObject(input: PutObjectInput) {
      const found = await db
        .select({ name: recordings.name })
        .from(recordings)
        .where(eq(recordings.name, input.recording));
      if (found.length === 0) return "recording_missing";

      const storagePath = `${input.recording}/${input.name}`;
      const body = input.body ?? new Uint8Array(0);
      const { error } = await bucket.upload(storagePath, body, {
        contentType: input.contentType ?? "application/octet-stream",
        upsert: true,
        duplex: "half",
      });
      if (error) throw error;

      const values = {
        recordingName: input.recording,
        name: input.name,
        kind: input.kind,
        storagePath,
        contentType: input.contentType ?? null,
        sizeBytes: input.sizeBytes,
        startTime: metaTime(input.meta, "starttime"),
        stopTime: metaTime(input.meta, "stoptime"),
        meta: input.meta,
      };
      await db
        .insert(recordingObjects)
        .values(values)
        .onConflictDoUpdate({
          target: [recordingObjects.recordingName, recordingObjects.name],
          set: { ...values, updatedAt: new Date() },
        });
      return "created";
    },

    async updateObject(recording, name, meta) {
      const rows = await db
        .update(recordingObjects)
        .set({ meta: mergedMeta(recordingObjects.meta, meta), updatedAt: new Date() })
        .where(sql`${recordingObjects.recordingName} = ${recording} and ${recordingObjects.name} = ${name}`)
        .returning({ id: recordingObjects.id });
      return rows.length > 0;
    },

    async claimForAnalysis(now = new Date()): Promise<AnalysisClaim | null> {
      const retryFrom = new Date(now.getTime() - RETRY_AFTER_MS);
      const next = db
        .select({ name: recordings.name })
        .from(recordings)
        .where(
          and(
            eq(recordings.status, "complete"),
            or(
              eq(recordings.analysisStatus, "pending"),
              and(
                eq(recordings.analysisStatus, "failed"),
                lt(recordings.analysisAttempts, MAX_ANALYSIS_ATTEMPTS),
                lte(recordings.analysedAt, retryFrom),
              ),
            ),
          ),
        )
        .orderBy(asc(recordings.completedAt))
        .limit(1)
        .for("update", { skipLocked: true });

      const rows = await db
        .update(recordings)
        .set({ analysisStatus: "running", updatedAt: new Date() })
        .where(inArray(recordings.name, next))
        .returning({ name: recordings.name, startTime: recordings.startTime });
      return rows[0] ?? null;
    },

    async clipSource(recording) {
      const rows = await db
        .select({ storagePath: recordingObjects.storagePath })
        .from(recordingObjects)
        .where(and(eq(recordingObjects.recordingName, recording), eq(recordingObjects.kind, "clip")))
        .orderBy(asc(recordingObjects.startTime))
        .limit(1);
      const storagePath = rows[0]?.storagePath;
      if (!storagePath) return null;
      const { data, error } = await bucket.createSignedUrl(storagePath, CLIP_URL_TTL_SECONDS);
      if (error) throw error;
      return data.signedUrl;
    },

    async finishAnalysis(recording, events) {
      await db.transaction(async (tx) => {
        await tx.delete(recordingEvents).where(eq(recordingEvents.recordingName, recording));
        if (events.length > 0) {
          await tx.insert(recordingEvents).values(
            events.map((event) => ({
              recordingName: recording,
              offsetSeconds: event.offsetSeconds,
              occurredAt: event.occurredAt,
              system: event.system,
              zone: event.zone,
              description: event.description,
              confidence: event.confidence,
              frameOffsets: event.frameOffsets,
            })),
          );
        }
        await tx
          .update(recordings)
          .set({ analysisStatus: "done", analysisError: null, analysedAt: new Date(), updatedAt: new Date() })
          .where(eq(recordings.name, recording));
      });
    },

    async failAnalysis(recording, reason) {
      await db
        .update(recordings)
        .set({
          analysisStatus: "failed",
          analysisError: reason,
          analysisAttempts: sql`${recordings.analysisAttempts} + 1`,
          analysedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(recordings.name, recording));
    },

    async refuseAnalysis(recording, reason) {
      await db
        .update(recordings)
        .set({
          analysisStatus: "refused",
          analysisError: reason,
          analysisAttempts: sql`${recordings.analysisAttempts} + 1`,
          analysedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(recordings.name, recording));
    },
  };
}
