import type { Meta } from "../store.js";

export type ObjectKind = "clip" | "key" | "bookmark" | "gps_trail" | "other";

export interface RecordingName {
  name: string;
  userId: string | null;
  deviceSerial: string | null;
  triggerOnTime: Date | null;
  rejected: boolean;
}

export interface PutObjectInput {
  recording: string;
  name: string;
  kind: ObjectKind;
  meta: Meta;
  body: ReadableStream<Uint8Array> | null;
  contentType: string | undefined;
  sizeBytes: number | null;
}

export interface AxisIngestStore {
  upsertSystem(id: string, meta: Meta): Promise<void>;
  upsertCameraUser(id: string, meta: Meta): Promise<void>;
  upsertDevice(serial: string, meta: Meta): Promise<void>;
  createRecording(recording: RecordingName, meta: Meta): Promise<"created" | "existing">;
  updateRecording(name: string, meta: Meta): Promise<boolean>;
  putObject(input: PutObjectInput): Promise<"created" | "recording_missing">;
  updateObject(recording: string, name: string, meta: Meta): Promise<boolean>;
}
