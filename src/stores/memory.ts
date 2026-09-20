import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AxisIngestStore, PutObjectInput, RecordingName } from "../axis/store.js";
import { metaTime, recordingStatus } from "../axis/swift.js";
import {
  MAX_ANALYSIS_ATTEMPTS,
  RETRY_AFTER_MS,
  type AnalysisClaim,
  type AnalysisEvent,
  type AnalysisStore,
  type Meta,
} from "../store.js";

export interface MemoryRecording extends RecordingName {
  status: string;
  meta: Meta;
  completedAt: Date | null;
  analysisStatus: string;
  analysisAttempts: number;
  analysisError: string | null;
  analysedAt: Date | null;
}

export interface MemoryObject {
  name: string;
  kind: string;
  contentType: string | undefined;
  sizeBytes: number | null;
  meta: Meta;
  bytes: Buffer;
}

async function collect(body: ReadableStream<Uint8Array> | null): Promise<Buffer> {
  if (!body) return Buffer.alloc(0);
  return Buffer.from(await new Response(body).arrayBuffer());
}

export class MemoryStore implements AxisIngestStore, AnalysisStore {
  readonly systems = new Map<string, Meta>();
  readonly cameraUsers = new Map<string, Meta>();
  readonly devices = new Map<string, Meta>();
  readonly recordings = new Map<string, MemoryRecording>();
  readonly objects = new Map<string, Map<string, MemoryObject>>();
  readonly events = new Map<string, AnalysisEvent[]>();

  async upsertSystem(id: string, meta: Meta): Promise<void> {
    this.systems.set(id, { ...this.systems.get(id), ...meta });
  }

  async upsertCameraUser(id: string, meta: Meta): Promise<void> {
    this.cameraUsers.set(id, { ...this.cameraUsers.get(id), ...meta });
  }

  async upsertDevice(serial: string, meta: Meta): Promise<void> {
    this.devices.set(serial, { ...this.devices.get(serial), ...meta });
  }

  async createRecording(recording: RecordingName, meta: Meta): Promise<"created" | "existing"> {
    if (this.recordings.has(recording.name)) {
      await this.updateRecording(recording.name, meta);
      return "existing";
    }
    this.recordings.set(recording.name, {
      ...recording,
      status: recordingStatus(meta, recording.rejected) ?? "transferring",
      meta,
      completedAt: null,
      analysisStatus: "pending",
      analysisAttempts: 0,
      analysisError: null,
      analysedAt: null,
    });
    this.objects.set(recording.name, new Map());
    return "created";
  }

  async updateRecording(name: string, meta: Meta): Promise<boolean> {
    const existing = this.recordings.get(name);
    if (!existing) return false;
    const status = recordingStatus(meta, existing.rejected) ?? existing.status;
    this.recordings.set(name, {
      ...existing,
      meta: { ...existing.meta, ...meta },
      status,
      completedAt: status === "complete" ? (existing.completedAt ?? new Date()) : existing.completedAt,
    });
    return true;
  }

  async putObject(input: PutObjectInput): Promise<"created" | "recording_missing"> {
    const objects = this.objects.get(input.recording);
    if (!objects) return "recording_missing";
    const bytes = await collect(input.body);
    objects.set(input.name, {
      name: input.name,
      kind: input.kind,
      contentType: input.contentType,
      sizeBytes: input.sizeBytes ?? bytes.byteLength,
      meta: input.meta,
      bytes,
    });
    return "created";
  }

  async updateObject(recording: string, name: string, meta: Meta): Promise<boolean> {
    const object = this.objects.get(recording)?.get(name);
    if (!object) return false;
    object.meta = { ...object.meta, ...meta };
    return true;
  }

  async claimForAnalysis(now = new Date()): Promise<AnalysisClaim | null> {
    const retryFrom = now.getTime() - RETRY_AFTER_MS;
    for (const recording of this.recordings.values()) {
      if (recording.status !== "complete") continue;
      const retryable =
        recording.analysisStatus === "failed" &&
        recording.analysisAttempts < MAX_ANALYSIS_ATTEMPTS &&
        recording.analysedAt !== null &&
        recording.analysedAt.getTime() <= retryFrom;
      if (recording.analysisStatus !== "pending" && !retryable) continue;
      recording.analysisStatus = "running";
      return { name: recording.name, startTime: metaTime(recording.meta, "starttime") };
    }
    return null;
  }

  async clipSource(recording: string): Promise<string | null> {
    const objects = this.objects.get(recording);
    if (!objects) return null;
    const clip = [...objects.values()].find((object) => object.kind === "clip");
    if (!clip) return null;
    const dir = await mkdtemp(join(tmpdir(), "traced-clip-"));
    const path = join(dir, clip.name.replaceAll("/", "_"));
    await writeFile(path, clip.bytes);
    return path;
  }

  async finishAnalysis(recording: string, events: AnalysisEvent[]): Promise<void> {
    const existing = this.recordings.get(recording);
    if (!existing) return;
    this.events.set(recording, events);
    existing.analysisStatus = "done";
    existing.analysisError = null;
    existing.analysedAt = new Date();
  }

  async failAnalysis(recording: string, reason: string): Promise<void> {
    const existing = this.recordings.get(recording);
    if (!existing) return;
    existing.analysisStatus = "failed";
    existing.analysisAttempts += 1;
    existing.analysisError = reason;
    existing.analysedAt = new Date();
  }

  async refuseAnalysis(recording: string, reason: string): Promise<void> {
    const existing = this.recordings.get(recording);
    if (!existing) return;
    existing.analysisStatus = "refused";
    existing.analysisAttempts += 1;
    existing.analysisError = reason;
    existing.analysedAt = new Date();
  }
}
