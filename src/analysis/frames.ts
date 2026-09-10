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

const DECODE_CEILING = 400;
const MIN_INTERVAL_SECONDS = 1;
const FRAME_LINE = /^frame:\d+\s+pts:\S+\s+pts_time:(-?[\d.]+)/gm;
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

export function selectExpression(sceneThreshold: number, interval: number | null): string {
  const terms = ["eq(n,0)", `gt(scene,${sceneThreshold})`];
  if (interval !== null) terms.push(`gte(t-prev_selected_t,${interval.toFixed(3)})`);
  return terms.join("+");
}

export function coverageInterval(duration: number | null, maxFrames: number): number | null {
  if (duration === null || maxFrames < 1) return null;
  return Math.max(MIN_INTERVAL_SECONDS, duration / maxFrames);
}

function parseOffsets(stdout: string): number[] {
  return [...stdout.matchAll(FRAME_LINE)].map((match) => Math.max(0, Number(match[1])));
}

function thin<T>(items: T[], max: number): T[] {
  if (items.length <= max || max < 1) return items;
  if (max === 1) return [items[0]!];
  const step = (items.length - 1) / (max - 1);
  return Array.from({ length: max }, (_, index) => items[Math.round(index * step)]!);
}

export const sampleFrames: FrameSampler = async (source, options) => {
  const interval = coverageInterval(await probeDuration(source), options.maxFrames);
  const dir = await mkdtemp(join(tmpdir(), "traced-frames-"));
  try {
    const stdout = await ffmpeg([
      "-hide_banner",
      "-loglevel",
      "error",
      "-i",
      source,
      "-vf",
      `select='${selectExpression(options.sceneThreshold, interval)}',metadata=print:file=-,scale=${options.width}:-2`,
      "-fps_mode",
      "vfr",
      "-frames:v",
      String(DECODE_CEILING),
      "-q:v",
      "4",
      join(dir, "frame-%04d.jpg"),
    ]);

    const offsets = parseOffsets(stdout);
    const files = (await readdir(dir)).sort();
    const frames = await Promise.all(
      files.map(async (file, index) => ({
        offsetSeconds: offsets[index] ?? 0,
        jpeg: await readFile(join(dir, file)),
      })),
    );
    return thin(frames, options.maxFrames);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
};
