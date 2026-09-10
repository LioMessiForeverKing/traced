import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ffmpegStatic from "ffmpeg-static";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { coverageInterval, probeDuration, sampleFrames, selectExpression } from "../src/analysis/frames.js";

const FFMPEG = ffmpegStatic as unknown as string;
const DURATION_SECONDS = 30;

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

  it("falls back to scene changes alone when the duration is unknown", () => {
    expect(coverageInterval(null, 24)).toBeNull();
    expect(selectExpression(0.4, null)).toBe("eq(n,0)+gt(scene,0.4)");
  });

  it("asks ffmpeg for a frame whenever the last one is old enough", () => {
    expect(selectExpression(0.4, 300)).toBe("eq(n,0)+gt(scene,0.4)+gte(t-prev_selected_t,300.000)");
  });
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
