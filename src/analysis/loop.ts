import type { AnalysisEvent, AnalysisStore } from "../store.js";
import type { EventExtractor, ExtractedEvent } from "./extractor.js";
import type { Frame, FrameSampler } from "./frames.js";

export interface AnalysisDeps {
  store: AnalysisStore;
  extractor: EventExtractor;
  sampler: FrameSampler;
  maxFrames: number;
  sceneThreshold: number;
  frameWidth: number;
  pollMs: number;
  log?: (line: Record<string, unknown>) => void;
}

export interface AnalysisLoop {
  runOnce(): Promise<string | null>;
  start(): void;
  stop(): void;
}

function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function toAnalysisEvents(
  extracted: ExtractedEvent[],
  frames: Frame[],
  startTime: Date | null,
): AnalysisEvent[] {
  const events: AnalysisEvent[] = [];
  for (const event of extracted) {
    const offsets = event.frameIndexes
      .filter((index) => index >= 0 && index < frames.length)
      .map((index) => frames[index]!.offsetSeconds)
      .sort((a, b) => a - b);
    if (offsets.length === 0) continue;
    const offsetSeconds = offsets[0]!;
    events.push({
      offsetSeconds,
      occurredAt: startTime ? new Date(startTime.getTime() + offsetSeconds * 1000) : null,
      system: event.system,
      zone: event.zone,
      description: event.description,
      confidence: Math.min(1, Math.max(0, event.confidence)),
      frameOffsets: offsets,
    });
  }
  return events.sort((a, b) => a.offsetSeconds - b.offsetSeconds);
}

export function createAnalysisLoop(deps: AnalysisDeps): AnalysisLoop {
  const log = deps.log ?? ((line) => console.log(JSON.stringify(line)));
  let timer: NodeJS.Timeout | null = null;
  let running = false;

  async function runOnce(): Promise<string | null> {
    const claim = await deps.store.claimForAnalysis();
    if (!claim) return null;
    try {
      const source = await deps.store.clipSource(claim.name);
      if (!source) throw new Error("recording has no clip to analyse");

      const frames = await deps.sampler(source, {
        maxFrames: deps.maxFrames,
        sceneThreshold: deps.sceneThreshold,
        width: deps.frameWidth,
      });
      if (frames.length === 0) throw new Error("no frames could be sampled from the clip");

      const extracted = await deps.extractor.extract({
        recording: claim.name,
        startTime: claim.startTime,
        frames,
      });
      const events = toAnalysisEvents(extracted, frames, claim.startTime);
      await deps.store.finishAnalysis(claim.name, events);
      log({ event: "analysed", recording: claim.name, frames: frames.length, events: events.length });
    } catch (error) {
      await deps.store.failAnalysis(claim.name, reason(error));
      log({ event: "analysis_failed", recording: claim.name, reason: reason(error) });
    }
    return claim.name;
  }

  async function drain(): Promise<void> {
    while (running && (await runOnce()) !== null) continue;
  }

  function schedule(): void {
    if (!running) return;
    timer = setTimeout(() => {
      void drain().catch((error) => log({ event: "analysis_loop_error", reason: reason(error) })).finally(schedule);
    }, deps.pollMs);
  }

  return {
    runOnce,
    start() {
      if (running) return;
      running = true;
      schedule();
    },
    stop() {
      running = false;
      if (timer) clearTimeout(timer);
      timer = null;
    },
  };
}
