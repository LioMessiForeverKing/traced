import {
  bigint,
  boolean,
  doublePrecision,
  index,
  jsonb,
  pgTable,
  real,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import type { Meta } from "../store.js";

const timestamps = {
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
};

export const bwsSystems = pgTable("bws_systems", {
  id: text("id").primaryKey(),
  connectionId: text("connection_id"),
  systemName: text("system_name"),
  meta: jsonb("meta").$type<Meta>().notNull(),
  ...timestamps,
}).enableRLS();

export const cameraUsers = pgTable("camera_users", {
  id: text("id").primaryKey(),
  name: text("name"),
  userId: text("user_id"),
  active: boolean("active"),
  meta: jsonb("meta").$type<Meta>().notNull(),
  ...timestamps,
}).enableRLS();

export const devices = pgTable("devices", {
  serial: text("serial").primaryKey(),
  name: text("name"),
  model: text("model"),
  active: boolean("active"),
  meta: jsonb("meta").$type<Meta>().notNull(),
  ...timestamps,
}).enableRLS();

export const recordings = pgTable("recordings", {
  name: text("name").primaryKey(),
  userId: text("user_id"),
  deviceSerial: text("device_serial"),
  status: text("status").notNull(),
  triggerOn: text("trigger_on"),
  triggerOff: text("trigger_off"),
  triggerOnTime: timestamp("trigger_on_time", { withTimezone: true }),
  triggerOffTime: timestamp("trigger_off_time", { withTimezone: true }),
  startTime: timestamp("start_time", { withTimezone: true }),
  stopTime: timestamp("stop_time", { withTimezone: true }),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  analysisStatus: text("analysis_status").notNull().default("pending"),
  analysisError: text("analysis_error"),
  analysedAt: timestamp("analysed_at", { withTimezone: true }),
  meta: jsonb("meta").$type<Meta>().notNull(),
  ...timestamps,
}).enableRLS();

export const recordingObjects = pgTable(
  "recording_objects",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    recordingName: text("recording_name")
      .notNull()
      .references(() => recordings.name, { onDelete: "cascade" }),
    name: text("name").notNull(),
    kind: text("kind").notNull(),
    storagePath: text("storage_path").notNull(),
    contentType: text("content_type"),
    sizeBytes: bigint("size_bytes", { mode: "number" }),
    startTime: timestamp("start_time", { withTimezone: true }),
    stopTime: timestamp("stop_time", { withTimezone: true }),
    meta: jsonb("meta").$type<Meta>().notNull(),
    ...timestamps,
  },
  (table) => [uniqueIndex("recording_objects_recording_name_name").on(table.recordingName, table.name)],
).enableRLS();

export const recordingEvents = pgTable(
  "recording_events",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    recordingName: text("recording_name")
      .notNull()
      .references(() => recordings.name, { onDelete: "cascade" }),
    offsetSeconds: doublePrecision("offset_seconds").notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }),
    system: text("system"),
    zone: text("zone"),
    description: text("description").notNull(),
    confidence: real("confidence").notNull(),
    frameOffsets: doublePrecision("frame_offsets").array().notNull(),
    ...timestamps,
  },
  (table) => [
    index("recording_events_recording_name").on(table.recordingName),
    index("recording_events_occurred_at").on(table.occurredAt),
  ],
).enableRLS();
