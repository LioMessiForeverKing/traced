export type Meta = Record<string, string>;

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

export interface RecordingStore extends AnalysisStore {
  upsertSystem(id: string, meta: Meta): Promise<void>;
  upsertCameraUser(id: string, meta: Meta): Promise<void>;
  upsertDevice(serial: string, meta: Meta): Promise<void>;
  createRecording(recording: RecordingName, meta: Meta): Promise<"created" | "existing">;
  updateRecording(name: string, meta: Meta): Promise<boolean>;
  putObject(input: PutObjectInput): Promise<"created" | "recording_missing">;
  updateObject(recording: string, name: string, meta: Meta): Promise<boolean>;
}

export interface AnalysisEvent {
  offsetSeconds: number;
  occurredAt: Date | null;
  system: string | null;
  zone: string | null;
  description: string;
  confidence: number;
  frameOffsets: number[];
}

export interface AnalysisClaim {
  name: string;
  startTime: Date | null;
}

export const MAX_ANALYSIS_ATTEMPTS = 3;
export const RETRY_AFTER_MS = 10 * 60 * 1000;

export interface AnalysisStore {
  claimForAnalysis(now?: Date): Promise<AnalysisClaim | null>;
  clipSource(recording: string): Promise<string | null>;
  finishAnalysis(recording: string, events: AnalysisEvent[]): Promise<void>;
  failAnalysis(recording: string, reason: string): Promise<void>;
}
