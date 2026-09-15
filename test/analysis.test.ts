import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import ffmpegStatic from "ffmpeg-static";
import { createApp } from "../src/app.js";
import { createAnalysisLoop, toAnalysisEvents } from "../src/analysis/loop.js";
import type { EventExtractor, ExtractedEvent, ExtractInput } from "../src/analysis/extractor.js";
import { redactUrls, sampleFrames } from "../src/analysis/frames.js";
import { MAX_ANALYSIS_ATTEMPTS, RETRY_AFTER_MS } from "../src/store.js";
import { MemoryStore } from "../src/stores/memory.js";
import { runFakeW800 } from "../src/testing/fake-w800.js";
import { CREDS, PUBLIC_URL } from "./credentials.js";

const FFMPEG = ffmpegStatic as unknown as string | null;
const SAMPLE = { maxFrames: 24, sceneThreshold: 0.4, width: 320 };

let fixtureDir = "";
let threeScenes = "";
let threeSceneBytes = new Uint8Array();

function ffmpeg(args: string[]): Promise<void> {
  if (!FFMPEG) throw new Error("no ffmpeg binary");
  const binary = FFMPEG;
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args);
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
    child.on("error", reject);
    child.on("close", (code: number | null) => (code === 0 ? resolve() : reject(new Error(stderr))));
  });
}

async function makeClip(path: string, sources: string[]): Promise<void> {
  const inputs = sources.flatMap((source) => ["-f", "lavfi", "-i", `${source}=size=320x240:rate=10:duration=2`]);
  const streams = sources.map((_, index) => `[${index}:v]`).join("");
  await ffmpeg([
    "-hide_banner",
    "-loglevel",
    "error",
    ...inputs,
    "-filter_complex",
    `${streams}concat=n=${sources.length}:v=1[v]`,
    "-map",
    "[v]",
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    path,
  ]);
}

function extractorReturning(events: ExtractedEvent[]): EventExtractor {
  return { async extract() { return events; } };
}

beforeAll(async () => {
  fixtureDir = await mkdtemp(join(tmpdir(), "traced-fixture-"));
  threeScenes = join(fixtureDir, "three-scenes.mp4");
  await makeClip(threeScenes, ["testsrc", "smptebars", "testsrc2"]);
  threeSceneBytes = new Uint8Array(await readFile(threeScenes));
}, 120_000);

afterAll(async () => {
  await rm(fixtureDir, { recursive: true, force: true });
});

describe("sampling frames out of a clip", () => {
  it("returns a frame at every scene change, timestamped, as jpeg", async () => {
    const frames = await sampleFrames(threeScenes, SAMPLE);
    const offsets = frames.map((frame) => Math.round(frame.offsetSeconds));

    expect(offsets).toEqual(expect.arrayContaining([0, 2, 4]));
    expect(offsets).toEqual([...offsets].sort((a, b) => a - b));
    for (const frame of frames) {
      expect(frame.jpeg.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]));
      expect(frame.jpeg.byteLength).toBeGreaterThan(0);
    }
  }, 60_000);

  it("keeps sampling a clip that never cuts, rather than stopping at the first frame", async () => {
    const still = join(fixtureDir, "still.mp4");
    await ffmpeg([
      "-hide_banner", "-loglevel", "error",
      "-f", "lavfi", "-i", "smptebars=size=320x240:rate=10:duration=20",
      "-pix_fmt", "yuv420p", still,
    ]);

    const frames = await sampleFrames(still, SAMPLE);

    expect(frames.length).toBeGreaterThan(1);
    expect(frames.at(-1)!.offsetSeconds).toBeGreaterThan(12);
  }, 120_000);

  it("never returns more frames than the cap, and always keeps the first", async () => {
    const busy = join(fixtureDir, "busy.mp4");
    await makeClip(busy, ["testsrc", "smptebars", "testsrc2", "testsrc", "smptebars", "testsrc2"]);

    const frames = await sampleFrames(busy, { ...SAMPLE, maxFrames: 3 });

    expect(frames).toHaveLength(3);
    expect(Math.round(frames[0]!.offsetSeconds)).toBe(0);
    expect(frames[2]!.offsetSeconds).toBeGreaterThan(frames[0]!.offsetSeconds);
  }, 120_000);

  it("keeps signed-url tokens out of the error it throws", async () => {
    const junk = join(fixtureDir, "not-video.mp4");
    await ffmpeg(["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "anullsrc=d=1", "-c:a", "aac", junk]);
    const signed = `${junk}?token=FAKE-TOKEN-VALUE-FOR-TESTS&scope=download`;

    await expect(sampleFrames(signed, SAMPLE)).rejects.toThrow(/ffmpeg exited/);
    await expect(sampleFrames(signed, SAMPLE)).rejects.not.toThrow(/FAKE-TOKEN-VALUE-FOR-TESTS/);
  }, 60_000);

  it("redacts the query string of a url but keeps the path", () => {
    const redacted = redactUrls(
      "moov atom not found\nhttps://x.supabase.co/storage/v1/object/sign/recordings/a/b.mp4?token=FAKE&scope=download",
    );

    expect(redacted).toContain("recordings/a/b.mp4?<redacted>");
    expect(redacted).not.toContain("FAKE");
    expect(redacted).toContain("moov atom not found");
  });

  it("fails loudly when the clip is not decodable video", async () => {
    const junk = join(fixtureDir, "junk.mp4");
    await ffmpeg(["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "anullsrc=d=1", "-c:a", "aac", junk]);

    await expect(sampleFrames(junk, SAMPLE)).rejects.toThrow(/ffmpeg exited/);
  }, 60_000);
});

describe("a complete recording becoming events", () => {
  async function offload(store: MemoryStore) {
    const app = createApp({ store, publicUrl: PUBLIC_URL, ...CREDS });
    return runFakeW800({
      baseUrl: PUBLIC_URL,
      username: CREDS.username,
      password: CREDS.password,
      fetch: async (url, init) => app.request(url, init),
      triggerOn: new Date("2026-09-08T17:12:09Z"),
      clipBytes: threeSceneBytes,
    });
  }

  it("samples the stored clip, writes timestamped events and marks the recording analysed", async () => {
    const store = new MemoryStore();
    const offloaded = await offload(store);
    const seen: ExtractInput[] = [];
    const extractor: EventExtractor = {
      async extract(input) {
        seen.push(input);
        return [
          { frameIndexes: [1, 2], system: "Framing", zone: "Level 3 East", description: "Stud wall going up", confidence: 0.8 },
          { frameIndexes: [0], system: null, zone: null, description: "Worker enters the floor", confidence: 0.4 },
        ];
      },
    };
    const loop = createAnalysisLoop({
      store,
      extractor,
      sampler: sampleFrames,
      ...SAMPLE,
      frameWidth: SAMPLE.width,
      pollMs: 1_000,
      log: () => {},
    });

    expect(await loop.runOnce()).toBe(offloaded.recordingName);

    expect(seen).toHaveLength(1);
    expect(seen[0]!.frames.length).toBeGreaterThanOrEqual(3);
    expect(seen[0]!.startTime?.toISOString()).toBe("2026-09-08T17:11:39.000Z");

    const events = store.events.get(offloaded.recordingName);
    expect(events).toHaveLength(2);
    expect(events![0]).toMatchObject({ offsetSeconds: 0, system: null, zone: null, description: "Worker enters the floor" });
    expect(events![0]!.occurredAt?.toISOString()).toBe("2026-09-08T17:11:39.000Z");
    expect(events![1]).toMatchObject({ system: "Framing", zone: "Level 3 East", confidence: 0.8 });
    expect(events![1]!.frameOffsets).toEqual([
      seen[0]!.frames[1]!.offsetSeconds,
      seen[0]!.frames[2]!.offsetSeconds,
    ]);
    const firstCited = seen[0]!.frames[1]!.offsetSeconds;
    expect(events![1]!.occurredAt?.getTime()).toBe(
      seen[0]!.startTime!.getTime() + firstCited * 1000,
    );

    const recording = store.recordings.get(offloaded.recordingName);
    expect(recording?.analysisStatus).toBe("done");
    expect(recording?.analysisError).toBeNull();
  }, 120_000);

  it("claims each recording once, so a second pass finds nothing", async () => {
    const store = new MemoryStore();
    await offload(store);
    const loop = createAnalysisLoop({
      store,
      extractor: extractorReturning([]),
      sampler: sampleFrames,
      ...SAMPLE,
      frameWidth: SAMPLE.width,
      pollMs: 1_000,
      log: () => {},
    });

    expect(await loop.runOnce()).not.toBeNull();
    expect(await loop.runOnce()).toBeNull();
  }, 120_000);

  it("records why analysis failed and does not retry it in a loop", async () => {
    const store = new MemoryStore();
    const offloaded = await offload(store);
    const loop = createAnalysisLoop({
      store,
      extractor: { async extract() { throw new Error("claude is down"); } },
      sampler: sampleFrames,
      ...SAMPLE,
      frameWidth: SAMPLE.width,
      pollMs: 1_000,
      log: () => {},
    });

    expect(await loop.runOnce()).toBe(offloaded.recordingName);
    expect(await loop.runOnce()).toBeNull();

    const recording = store.recordings.get(offloaded.recordingName);
    expect(recording?.analysisStatus).toBe("failed");
    expect(recording?.analysisError).toBe("claude is down");
    expect(store.events.get(offloaded.recordingName)).toBeUndefined();
  }, 120_000);

  it("leaves a recording that never got a clip in failed, not silently done", async () => {
    const store = new MemoryStore();
    const name = "6f1d2c3b-4a5e-4f60-8a9b-0c1d2e3f4a5b_B8A44F000001_20260908T171209Z";
    await store.createRecording(
      { name, userId: null, deviceSerial: null, triggerOnTime: null, rejected: false },
      { status: "Complete" },
    );
    const loop = createAnalysisLoop({
      store,
      extractor: extractorReturning([]),
      sampler: sampleFrames,
      ...SAMPLE,
      frameWidth: SAMPLE.width,
      pollMs: 1_000,
      log: () => {},
    });

    expect(await loop.runOnce()).toBe(name);
    expect(store.recordings.get(name)?.analysisStatus).toBe("failed");
    expect(store.recordings.get(name)?.analysisError).toMatch(/no clip/);
  });
});

describe("mapping what the model said onto the frames it saw", () => {
  const frames = [0, 2.5, 7].map((offsetSeconds) => ({ offsetSeconds, sceneChange: false, jpeg: Buffer.alloc(0) }));
  const startTime = new Date("2026-09-08T17:00:00Z");

  it("orders events by offset and derives wall-clock from the recording start", () => {
    const events = toAnalysisEvents(
      [
        { frameIndexes: [2], system: "HVAC", zone: null, description: "Duct hung", confidence: 0.9 },
        { frameIndexes: [0, 1], system: "Concrete", zone: null, description: "Pour begins", confidence: 0.7 },
      ],
      frames,
      startTime,
    );

    expect(events.map((event) => event.offsetSeconds)).toEqual([0, 7]);
    expect(events[0]!.frameOffsets).toEqual([0, 2.5]);
    expect(events[0]!.occurredAt?.toISOString()).toBe("2026-09-08T17:00:00.000Z");
    expect(events[1]!.occurredAt?.toISOString()).toBe("2026-09-08T17:00:07.000Z");
  });

  it("drops events citing frames that do not exist and clamps confidence", () => {
    const events = toAnalysisEvents(
      [
        { frameIndexes: [9], system: null, zone: null, description: "Invented", confidence: 0.5 },
        { frameIndexes: [1, 42], system: null, zone: null, description: "Half invented", confidence: 4 },
      ],
      frames,
      startTime,
    );

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ description: "Half invented", confidence: 1, offsetSeconds: 2.5 });
  });

  it("leaves wall-clock null when the recording never reported a start time", () => {
    const events = toAnalysisEvents(
      [{ frameIndexes: [0], system: null, zone: null, description: "Something", confidence: 0.5 }],
      frames,
      null,
    );

    expect(events[0]!.occurredAt).toBeNull();
  });
});

describe("retrying a failed analysis", () => {
  const RECORDING = "retry-me";

  async function failedRecording(attempts: number, analysedAt: Date) {
    const store = new MemoryStore();
    await store.createRecording(
      { name: RECORDING, userId: null, deviceSerial: null, triggerOnTime: null, rejected: false },
      { status: "complete" },
    );
    const recording = store.recordings.get(RECORDING)!;
    recording.status = "complete";
    recording.analysisStatus = "failed";
    recording.analysisAttempts = attempts;
    recording.analysedAt = analysedAt;
    return store;
  }

  it("claims a failed recording again once the backoff has passed", async () => {
    const now = new Date("2026-09-10T12:00:00Z");
    const store = await failedRecording(1, new Date(now.getTime() - RETRY_AFTER_MS - 1_000));

    expect(await store.claimForAnalysis(now)).toMatchObject({ name: RECORDING });
  });

  it("leaves it alone until the backoff has passed", async () => {
    const now = new Date("2026-09-10T12:00:00Z");
    const store = await failedRecording(1, new Date(now.getTime() - 60_000));

    expect(await store.claimForAnalysis(now)).toBeNull();
  });

  it("gives up after the attempt cap, rather than retrying a broken clip forever", async () => {
    const now = new Date("2026-09-10T12:00:00Z");
    const store = await failedRecording(
      MAX_ANALYSIS_ATTEMPTS,
      new Date(now.getTime() - RETRY_AFTER_MS - 1_000),
    );

    expect(await store.claimForAnalysis(now)).toBeNull();
  });

  it("counts every failure, so the cap is reachable", async () => {
    const store = await failedRecording(0, new Date(0));
    await store.failAnalysis(RECORDING, "ffmpeg fell over");
    await store.failAnalysis(RECORDING, "ffmpeg fell over again");

    expect(store.recordings.get(RECORDING)!.analysisAttempts).toBe(2);
  });

  it("still claims a pending recording without waiting for any backoff", async () => {
    const store = new MemoryStore();
    await store.createRecording(
      { name: "fresh", userId: null, deviceSerial: null, triggerOnTime: null, rejected: false },
      { status: "complete" },
    );
    store.recordings.get("fresh")!.status = "complete";

    expect(await store.claimForAnalysis(new Date())).toMatchObject({ name: "fresh" });
  });
});
