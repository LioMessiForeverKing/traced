export type Meta = Record<string, string>;

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
  refuseAnalysis(recording: string, reason: string): Promise<void>;
}
