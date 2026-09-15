import { spawn } from "node:child_process";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ffmpegStatic from "ffmpeg-static";

export interface Frame {
  offsetSeconds: number;
  sceneChange: boolean;
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
const FRAME_LINE = /^frame:\d+\s+pts:\S+\s+pts_time:(-?[\d.]+)(?:\s*\nlavfi\.scene_score=([\d.]+))?/gm;
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

interface Selection {
  offsetSeconds: number;
  sceneScore: number;
}

function parseSelections(stdout: string): Selection[] {
  return [...stdout.matchAll(FRAME_LINE)].map((match) => ({
    offsetSeconds: Math.max(0, Number(match[1])),
    sceneScore: Number(match[2] ?? 0),
  }));
}

export function spreadOverTime(frames: Frame[], maxFrames: number): Frame[] {
  if (frames.length <= maxFrames || maxFrames < 1) return frames;
  if (maxFrames === 1) return [frames[0]!];
  const first = frames[0]!.offsetSeconds;
  const span = frames.at(-1)!.offsetSeconds - first;
  const tolerance = span / (maxFrames - 1) / 2;
  const taken = new Set<number>([0]);
  const chosen: Frame[] = [frames[0]!];
  for (let slot = 1; slot < maxFrames; slot += 1) {
    const target = first + (span * slot) / (maxFrames - 1);
    const reaches = slot === 1 ? first : target - tolerance;
    let nearest = -1;
    let nearestDistance = Infinity;
    let scene = -1;
    let sceneDistance = Infinity;
    for (let index = 0; index < frames.length; index += 1) {
      if (taken.has(index)) continue;
      const offset = frames[index]!.offsetSeconds;
      const distance = Math.abs(offset - target);
      if (distance < nearestDistance) {
        nearestDistance = distance;
        nearest = index;
      }
      const within = offset >= reaches && offset <= target + tolerance;
      if (frames[index]!.sceneChange && within && distance < sceneDistance) {
        sceneDistance = distance;
        scene = index;
      }
    }
    const best = scene >= 0 ? scene : nearest;
    if (best < 0) break;
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

    const selections = parseSelections(stdout);
    const files = (await readdir(dir)).sort();
    if (selections.length !== files.length) {
      throw new Error(`ffmpeg timed ${selections.length} frames but wrote ${files.length}`);
    }
    const frames = await Promise.all(
      files.map(async (file, index) => ({
        offsetSeconds: selections[index]!.offsetSeconds,
        sceneChange: selections[index]!.sceneScore > options.sceneThreshold,
        jpeg: await readFile(join(dir, file)),
      })),
    );
    return spreadOverTime(frames, options.maxFrames);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
};
