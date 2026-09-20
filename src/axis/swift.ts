import type { Meta } from "../store.js";
import type { ObjectKind, RecordingName } from "./store.js";

const META_PREFIXES = ["x-object-meta-", "x-container-meta-"];
const RECORDING = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})_([A-Za-z0-9]+)_(\d{8}T\d{6}Z)$/i;
const REJECTED = /^RejectedContent_(\d{8}T\d{6}Z|UnknownTime)_(.+)$/;
const COMPACT_UTC = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/;

export const FIXED_CONTAINERS = new Set(["System", "Users", "Devices"]);

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export function parseMeta(headers: Headers): Meta {
  const meta: Meta = {};
  headers.forEach((value, key) => {
    const prefix = META_PREFIXES.find((p) => key.startsWith(p) && key.length > p.length);
    if (prefix) meta[key.slice(prefix.length)] = safeDecode(value);
  });
  return meta;
}

export function parseCompactUtc(value: string): Date | null {
  const m = COMPACT_UTC.exec(value);
  if (!m) return null;
  return new Date(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z`);
}

export function parseRecordingName(name: string): RecordingName | null {
  const recording = RECORDING.exec(name);
  if (recording) {
    return {
      name,
      userId: recording[1]!.toLowerCase(),
      deviceSerial: recording[2]!,
      triggerOnTime: parseCompactUtc(recording[3]!),
      rejected: false,
    };
  }
  const rejected = REJECTED.exec(name);
  if (rejected) {
    return {
      name,
      userId: null,
      deviceSerial: null,
      triggerOnTime: parseCompactUtc(rejected[1]!),
      rejected: true,
    };
  }
  return null;
}

export function metaTime(meta: Meta, field: string): Date | null {
  const iso = meta[`${field}iso`];
  if (iso) {
    const date = new Date(iso);
    if (!Number.isNaN(date.getTime())) return date;
  }
  const epoch = meta[field];
  if (epoch && /^\d+$/.test(epoch)) return new Date(Number(epoch) * 1000);
  return null;
}

export function classifyObject(name: string): ObjectKind {
  if (name.startsWith("bookmark_")) return "bookmark";
  if (name.endsWith("_gpstrail.json")) return "gps_trail";
  if (name.endsWith(".key")) return "key";
  if (/\.(mp4|mkv)$/i.test(name)) return "clip";
  return "other";
}

export function recordingStatus(meta: Meta, rejected: boolean): string | null {
  if (rejected) return "rejected";
  const status = meta.status?.toLowerCase();
  if (status === "complete" || status === "transferring") return status;
  return null;
}
