import { spawn } from "node:child_process";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ffmpegStatic from "ffmpeg-static";

export interface Frame {
  offsetSeconds: number;
  jpeg: Buffer;
}

export interface SampleOptions {
  maxFrames: number;
  sceneThreshold: number;
  width: number;
}

export type FrameSampler = (source: string, options: SampleOptions) => Promise<Frame[]>;

// ffmpeg-static is CJS with `module.exports = <path string>` but ships an ESM `export default` typing,
// so the import is the string at runtime and the namespace to the compiler.
const FFMPEG = ffmpegStatic as unknown as string | null;

export const DECODE_CEILING = 400;
const MIN_INTERVAL_SECONDS = 1;
const SCENE_SPACING_DIVISOR = 4;
const FRAME_LINE = /^frame:(\d+)\s+pts:\S+\s+pts_time:(-?[\d.]+)/gm;
const DURATION_LINE = /Duration:\s*(\d+):(\d{2}):(\d{2}(?:\.\d+)?)/;
const URL_WITH_QUERY = /((?:https?:\/\/|\/)\S*?)\?\S*/g;

export function redactUrls(text: string): string {
  return text.replace(URL_WITH_QUERY, "$1?<redacted>");
}

interface Completed {
  stdout: string;
  stderr: string;
  code: number | null;
}

function run(args: string[]): Promise<Completed> {
  if (!FFMPEG) throw new Error("ffmpeg-static did not resolve a binary for this platform");
  const binary = FFMPEG;
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args);
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf8")));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
    child.on("error", reject);
    child.on("close", (code: number | null) => resolve({ stdout, stderr, code }));
  });
}

async function ffmpeg(args: string[]): Promise<string> {
  const { stdout, stderr, code } = await run(args);
  if (code !== 0) throw new Error(`ffmpeg exited ${code}: ${redactUrls(stderr.trim()).slice(0, 500)}`);
  return stdout;
}

export async function probeDuration(source: string): Promise<number | null> {
  const { stderr } = await run(["-hide_banner", "-i", source]);
  const match = DURATION_LINE.exec(stderr);
  if (!match) return null;
  const seconds = Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
  return Number.isFinite(seconds) && seconds > 0 ? seconds : null;
}

function ceilingSpacing(duration: number): number {
  return duration / (DECODE_CEILING - 1);
}

export function coverageInterval(duration: number | null, maxFrames: number): number | null {
  if (duration === null || maxFrames < 1) return null;
  return Math.max(MIN_INTERVAL_SECONDS, duration / maxFrames, ceilingSpacing(duration));
}

export function sceneSpacing(duration: number | null, interval: number | null): number | null {
  if (duration === null || interval === null) return null;
  return Math.max(interval / SCENE_SPACING_DIVISOR, ceilingSpacing(duration));
}

export function selectExpression(
  sceneThreshold: number,
  interval: number | null,
  spacing: number | null,
): string {
  const scene =
    spacing === null
      ? `gt(scene,${sceneThreshold})`
      : `gt(scene,${sceneThreshold})*gte(t-prev_selected_t,${spacing.toFixed(3)})`;
  const terms = ["eq(n,0)", scene];
  if (interval !== null) terms.push(`gte(t-prev_selected_t,${interval.toFixed(3)})`);
  return terms.join("+");
}

interface Timing {
  index: number;
  offsetSeconds: number;
}

function parseTimings(stdout: string): Timing[] {
  return [...stdout.matchAll(FRAME_LINE)].flatMap((match) => {
    const offsetSeconds = Number(match[2]);
    return Number.isFinite(offsetSeconds)
      ? [{ index: Number(match[1]), offsetSeconds: Math.max(0, offsetSeconds) }]
      : [];
  });
}

export function spreadOverTime(frames: Frame[], maxFrames: number): Frame[] {
  if (frames.length <= maxFrames || maxFrames < 1) return frames;
  if (maxFrames === 1) return [frames[0]!];
  const first = frames[0]!.offsetSeconds;
  const span = frames.at(-1)!.offsetSeconds - first;
  const taken = new Set<number>([0]);
  const chosen: Frame[] = [frames[0]!];
  for (let slot = 1; slot < maxFrames; slot += 1) {
    const target = first + (span * slot) / (maxFrames - 1);
    let best = -1;
    let bestDistance = Infinity;
    for (let index = 0; index < frames.length; index += 1) {
      if (taken.has(index)) continue;
      const distance = Math.abs(frames[index]!.offsetSeconds - target);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = index;
      }
    }
    if (best < 0) throw new Error(`frame ${slot} of ${maxFrames} has no comparable offset`);
    taken.add(best);
    chosen.push(frames[best]!);
  }
  return chosen.sort((left, right) => left.offsetSeconds - right.offsetSeconds);
}

export const sampleFrames: FrameSampler = async (source, options) => {
  const duration = await probeDuration(source);
  const interval = coverageInterval(duration, options.maxFrames);
  const spacing = sceneSpacing(duration, interval);
  const dir = await mkdtemp(join(tmpdir(), "traced-frames-"));
  try {
    const stdout = await ffmpeg([
      "-hide_banner",
      "-loglevel",
      "error",
      "-i",
      source,
      "-vf",
      `select='${selectExpression(options.sceneThreshold, interval, spacing)}',metadata=print:file=-,scale=${options.width}:-2`,
      "-fps_mode",
      "vfr",
      "-frames:v",
      String(DECODE_CEILING),
      "-q:v",
      "4",
      join(dir, "frame-%04d.jpg"),
    ]);

    const timings = parseTimings(stdout);
    const files = (await readdir(dir)).sort();
    files.forEach((_, index) => {
      if (timings[index]?.index !== index) {
        throw new Error(`ffmpeg did not time frame ${index} of the ${files.length} it wrote`);
      }
    });
    const frames = await Promise.all(
      files.map(async (file, index) => ({
        offsetSeconds: timings[index]!.offsetSeconds,
        jpeg: await readFile(join(dir, file)),
      })),
    );
    return spreadOverTime(frames, options.maxFrames);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
};
