import { spawn } from "node:child_process";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ffmpegStatic from "ffmpeg-static";

/** Thrown only where a short read cannot fake the result: selection is causal, so a truncated
 * transfer yields fewer frames and never more. Everything else stays a retryable Error. */
export class UnanalysableRecording extends Error {
  readonly name = "UnanalysableRecording";
}

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
const DECODE_REQUEST = DECODE_CEILING + 1;
const GATE_DECIMALS = 3;
const MIN_INTERVAL_SECONDS = 1;
const SCENE_SPACING_DIVISOR = 4;
const FRAME_LINE = /^frame:(\d+)\s+pts:\S+\s+pts_time:(-?[\d.]+)/gm;
const DURATION_LINE = /Duration:\s*(\d+):(\d{2}):(\d{2}(?:\.\d+)?)/;
const OPENED_LINE = /^Input #0/m;
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

async function probe(source: string): Promise<{ seconds: number | null; opened: boolean; stderr: string }> {
  const { stderr } = await run(["-hide_banner", "-i", source]);
  const opened = OPENED_LINE.test(stderr);
  const match = DURATION_LINE.exec(stderr);
  if (!match) return { seconds: null, opened, stderr };
  const seconds = Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
  return { seconds: Number.isFinite(seconds) && seconds > 0 ? seconds : null, opened, stderr };
}

export async function probeDuration(source: string): Promise<number | null> {
  return (await probe(source)).seconds;
}

function ceilingSpacing(duration: number): number {
  return duration / (DECODE_CEILING - 1);
}

export function coverageInterval(duration: number, maxFrames: number): number {
  return Math.max(MIN_INTERVAL_SECONDS, duration / Math.max(1, maxFrames), ceilingSpacing(duration));
}

export function sceneSpacing(duration: number, interval: number): number {
  return Math.max(interval / SCENE_SPACING_DIVISOR, ceilingSpacing(duration));
}

export function selectExpression(sceneThreshold: number, interval: number, spacing: number): string {
  return [
    "eq(n,0)",
    `gt(scene,${sceneThreshold})*gte(t-prev_selected_t,${spacing.toFixed(GATE_DECIMALS)})`,
    `gte(t-prev_selected_t,${interval.toFixed(GATE_DECIMALS)})`,
  ].join("+");
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
    taken.add(best);
    chosen.push(frames[best]!);
  }
  return chosen.sort((left, right) => left.offsetSeconds - right.offsetSeconds);
}

export const sampleFrames: FrameSampler = async (source, options) => {
  const { seconds: duration, opened, stderr } = await probe(source);
  const detail = redactUrls(stderr.trim()).slice(0, 500);
  if (!opened) throw new Error(`ffmpeg could not open the recording: ${detail}`);
  if (duration === null) {
    throw new Error(`ffmpeg read no duration for the recording, so its coverage cannot be bounded: ${detail}`);
  }
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
      "passthrough",
      "-frames:v",
      String(DECODE_REQUEST),
      "-q:v",
      "4",
      join(dir, "frame-%04d.jpg"),
    ]);

    const timed = new Map(parseTimings(stdout).map((timing) => [timing.index, timing.offsetSeconds]));
    const files = (await readdir(dir)).sort();
    if (files.length > 0 && timed.size === 0) {
      throw new UnanalysableRecording(
        `ffmpeg wrote ${files.length} frames and printed no timings this build could read`,
      );
    }
    if (files.length >= DECODE_REQUEST) {
      throw new UnanalysableRecording(
        `ffmpeg was still finding frames at the ${DECODE_REQUEST}th, so the clip runs past what was sampled`,
      );
    }
    const frames = await Promise.all(
      files.flatMap((file, index) => {
        const offsetSeconds = timed.get(index);
        return offsetSeconds === undefined
          ? []
          : [readFile(join(dir, file)).then((jpeg) => ({ offsetSeconds, jpeg }))];
      }),
    );
    return spreadOverTime(frames, options.maxFrames);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
};
