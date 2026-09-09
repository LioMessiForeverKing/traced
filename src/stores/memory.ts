import type { Meta, PutObjectInput, RecordingName, RecordingStore } from "../store.js";
import { recordingStatus } from "../swift.js";

export interface MemoryRecording extends RecordingName {
  status: string;
  meta: Meta;
  completedAt: Date | null;
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

export class MemoryStore implements RecordingStore {
  readonly systems = new Map<string, Meta>();
  readonly cameraUsers = new Map<string, Meta>();
  readonly devices = new Map<string, Meta>();
  readonly recordings = new Map<string, MemoryRecording>();
  readonly objects = new Map<string, Map<string, MemoryObject>>();

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
}
