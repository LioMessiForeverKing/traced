import { spawn } from "node:child_process";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ffmpegStatic from "ffmpeg-static";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  DECODE_CEILING,
  UnanalysableRecording,
  coverageInterval,
  probeDuration,
  sampleFrames,
  sceneSpacing,
  selectExpression,
  spreadOverTime,
} from "../src/analysis/frames.js";
import type { Frame } from "../src/analysis/frames.js";

const FFMPEG = ffmpegStatic as unknown as string;
const DURATION_SECONDS = 30;
const SAMPLE = { maxFrames: 24, sceneThreshold: 0.4, width: 320 };

let dir = "";
let clip = "";

function ffmpeg(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(FFMPEG, args);
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}`))));
  });
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "traced-frames-test-"));
  clip = join(dir, "continuous.mp4");
  await ffmpeg([
    "-hide_banner",
    "-loglevel",
    "error",
    "-f",
    "lavfi",
    "-i",
    `smptebars=duration=${DURATION_SECONDS}:size=320x240:rate=10`,
    "-pix_fmt",
    "yuv420p",
    clip,
  ]);
}, 60_000);

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("coverage interval", () => {
  it("spreads the frame budget across the whole recording", () => {
    expect(coverageInterval(7200, 24)).toBe(300);
    expect(coverageInterval(30, 10)).toBe(3);
  });

  it("never samples faster than once a second, however short the clip", () => {
    expect(coverageInterval(4, 24)).toBe(1);
  });

  it("asks ffmpeg for a frame whenever the last one is old enough", () => {
    expect(selectExpression(0.4, 300, 75)).toBe(
      "eq(n,0)+gt(scene,0.4)*gte(t-prev_selected_t,75.000)+gte(t-prev_selected_t,300.000)",
    );
  });
});

describe("scene spacing", () => {
  it("holds scene changes apart in proportion to the coverage interval", () => {
    expect(sceneSpacing(7200, 300)).toBe(75);
  });

  it("keeps the whole recording inside the decode ceiling at any budget", () => {
    for (const duration of [17.7, 79.8, 120, 600, 3600, 7200]) {
      for (const maxFrames of [1, 24, 100, 200, 400, 600]) {
        const interval = coverageInterval(duration, maxFrames);
        const spacing = sceneSpacing(duration, interval);
        const selections = 1 + Math.floor(duration / Math.min(interval, spacing));
        expect(selections).toBeLessThanOrEqual(DECODE_CEILING);
      }
    }
  });

  it("stays inside the ceiling at the precision ffmpeg is actually given", () => {
    for (const duration of [17.7, 79.8, 120, 600, 3600, 7200]) {
      for (const maxFrames of [1, 24, 100, 200, 400, 600]) {
        const interval = coverageInterval(duration, maxFrames);
        const spacing = sceneSpacing(duration, interval);
        const expression = selectExpression(0, interval, spacing);
        const gaps = [...expression.matchAll(/gte\(t-prev_selected_t,([\d.]+)\)/g)].map((m) => Number(m[1]));
        expect(1 + Math.floor(duration / Math.min(...gaps))).toBeLessThanOrEqual(DECODE_CEILING);
      }
    }
  });
});

describe("spreading the frame budget", () => {
  const frame = (offsetSeconds: number): Frame => ({ offsetSeconds, jpeg: Buffer.alloc(1) });

  it("keeps every frame when the budget is not exceeded", () => {
    const frames = [frame(0), frame(5), frame(10)];
    expect(spreadOverTime(frames, 24)).toEqual(frames);
  });

  it("spends the budget on the recording, not on the busiest three seconds", () => {
    const burst = Array.from({ length: 30 }, (_, index) => frame(index * 0.1));
    const rest = Array.from({ length: 10 }, (_, index) => frame((index + 1) * 10));
    const chosen = spreadOverTime([...burst, ...rest], 5);

    expect(chosen.map((f) => f.offsetSeconds)).toEqual([0, 20, 50, 70, 100]);
  });

  it("spans from the first frame, not from zero", () => {
    const candidates = [frame(100), frame(110), frame(150), frame(200)];

    expect(spreadOverTime(candidates, 3).map((f) => f.offsetSeconds)).toEqual([100, 150, 200]);
  });

  it("spans the frames it has, not a container that outlasts them", () => {
    const video = Array.from({ length: 61 }, (_, index) => frame(index));
    expect(spreadOverTime(video, 5).map((f) => f.offsetSeconds)).toEqual([0, 15, 30, 45, 60]);
  });

  it("keeps the recording's last frame, not a crowd near the end", () => {
    const candidates = [frame(0), frame(50), frame(74), frame(76), frame(100)];

    expect(spreadOverTime(candidates, 3).map((f) => f.offsetSeconds)).toEqual([0, 50, 100]);
  });

  it("returns frames in recording order", () => {
    const frames = Array.from({ length: 40 }, (_, index) => frame(index * 3));
    const offsets = spreadOverTime(frames, 6).map((f) => f.offsetSeconds);
    expect(offsets).toEqual([...offsets].sort((a, b) => a - b));
  });
});

describe("a recording whose length cannot be read", () => {
  it("is rejected rather than sampled from its opening frame", async () => {
    const raw = join(dir, "headless.h264");
    await ffmpeg([
      "-hide_banner", "-loglevel", "error",
      "-f", "lavfi", "-i", `smptebars=duration=${DURATION_SECONDS}:size=320x240:rate=10`,
      "-c:v", "libx264", "-bsf:v", "h264_mp4toannexb", "-f", "h264", raw,
    ]);

    expect(await probeDuration(raw)).toBeNull();
    const failure = await sampleFrames(raw, SAMPLE).catch((error: unknown) => error);

    expect(String(failure)).toMatch(/read no duration for the recording/);
    expect(failure).not.toBeInstanceOf(UnanalysableRecording);
  }, 60_000);

  it("is retried, because a healthy stream can read no duration over http alone", async () => {
    const transport = join(dir, "streamable.ts");
    await ffmpeg([
      "-hide_banner", "-loglevel", "error",
      "-f", "lavfi", "-i", `smptebars=duration=${DURATION_SECONDS}:size=320x240:rate=10`,
      "-pix_fmt", "yuv420p", transport,
    ]);
    const bytes = await readFile(transport);
    const server = createServer((_request, response) => {
      response.writeHead(200, { "Content-Type": "video/mp2t" });
      response.end(bytes);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const { port } = server.address() as AddressInfo;

    try {
      const served = `http://127.0.0.1:${port}/recordings/clip.ts`;
      expect(await probeDuration(served)).toBeNull();
      const failure = await sampleFrames(served, SAMPLE).catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(Error);
      expect(failure).not.toBeInstanceOf(UnanalysableRecording);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }, 120_000);
});

describe("a recording ffmpeg could not reach", () => {
  it("is left retryable, because a blip and a broken clip fail the same way", async () => {
    const server = createServer((_request, response) => {
      response.writeHead(503);
      response.end("storage is having a moment");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const { port } = server.address() as AddressInfo;

    try {
      const signed = `http://127.0.0.1:${port}/recordings/clip.mp4?token=FAKE-TOKEN-VALUE-FOR-TESTS`;
      const failure = await sampleFrames(signed, SAMPLE).catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(Error);
      expect(failure).not.toBeInstanceOf(UnanalysableRecording);
      expect(String(failure)).toMatch(/could not open the recording/);
      expect(String(failure)).not.toMatch(/FAKE-TOKEN-VALUE-FOR-TESTS/);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }, 60_000);
});

describe("a recording whose own frames are far apart", () => {
  it("is not mistaken for one that stopped early", async () => {
    const lapse = join(dir, "lapse.mp4");
    await ffmpeg([
      "-hide_banner", "-loglevel", "error",
      "-f", "lavfi", "-i", `testsrc2=duration=${DURATION_SECONDS}:size=320x240:rate=0.4`,
      "-pix_fmt", "yuv420p", "-r", "0.4", lapse,
    ]);

    const frames = await sampleFrames(lapse, { maxFrames: 24, sceneThreshold: 0.4, width: 320 });
    expect(frames.length).toBeGreaterThan(1);
  }, 120_000);
});

describe("sampling a continuous recording", () => {
  it("reads the duration off the container", async () => {
    const duration = await probeDuration(clip);
    expect(duration).toBeGreaterThan(DURATION_SECONDS - 1);
    expect(duration).toBeLessThan(DURATION_SECONDS + 1);
  });

  it("covers the whole clip even though nothing in it ever cuts", async () => {
    const frames = await sampleFrames(clip, { maxFrames: 10, sceneThreshold: 0.4, width: 320 });

    expect(frames.length).toBeGreaterThan(1);
    expect(frames[0]!.offsetSeconds).toBe(0);
    expect(frames.at(-1)!.offsetSeconds).toBeGreaterThan(DURATION_SECONDS * 0.6);
    expect(frames.every((frame) => frame.jpeg.byteLength > 0)).toBe(true);
  }, 60_000);

  it("never returns more than the frame budget", async () => {
    const frames = await sampleFrames(clip, { maxFrames: 4, sceneThreshold: 0.4, width: 320 });
    expect(frames.length).toBeLessThanOrEqual(4);
  }, 60_000);
});
