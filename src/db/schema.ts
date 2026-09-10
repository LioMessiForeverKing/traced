import { type SQL, sql } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import {
  bigint,
  boolean,
  doublePrecision,
  index,
  jsonb,
  pgPolicy,
  pgTable,
  primaryKey,
  real,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { authUid, authUsers, authenticatedRole } from "drizzle-orm/supabase";
import type { Meta } from "../store.js";

const timestamps = {
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
};

const signedIn = sql`${authUid} is not null`;

function memberOf(project: AnyPgColumn) {
  return sql`${signedIn} and public.is_project_member(${project})`;
}

function memberOfRecording(recording: AnyPgColumn) {
  return sql`${signedIn} and public.is_recording_member(${recording})`;
}

function readableByMembers(name: string, predicate: SQL) {
  return pgPolicy(name, { as: "permissive", for: "select", to: authenticatedRole, using: predicate });
}

const projectRef = () =>
  uuid("project_id")
    .notNull()
    .references(() => projects.id, { onDelete: "restrict" });

export const projects = pgTable(
  "projects",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    name: text("name").notNull(),
    ...timestamps,
  },
  (table) => [readableByMembers("projects_select_member", memberOf(table.id))],
);

export const projectMembers = pgTable(
  "project_members",
  {
    projectId: projectRef(),
    userId: uuid("user_id")
      .notNull()
      .references(() => authUsers.id, { onDelete: "cascade" }),
    ...timestamps,
  },
  (table) => [
    primaryKey({ columns: [table.projectId, table.userId] }),
    readableByMembers("project_members_select_member", memberOf(table.projectId)),
  ],
);

export const bwsSystems = pgTable(
  "bws_systems",
  {
    id: text("id").primaryKey(),
    projectId: projectRef(),
    connectionId: text("connection_id"),
    systemName: text("system_name"),
    meta: jsonb("meta").$type<Meta>().notNull(),
    ...timestamps,
  },
  (table) => [readableByMembers("bws_systems_select_member", memberOf(table.projectId))],
).enableRLS();

export const cameraUsers = pgTable(
  "camera_users",
  {
    id: text("id").primaryKey(),
    projectId: projectRef(),
    name: text("name"),
    userId: text("user_id"),
    active: boolean("active"),
    meta: jsonb("meta").$type<Meta>().notNull(),
    ...timestamps,
  },
  (table) => [readableByMembers("camera_users_select_member", memberOf(table.projectId))],
).enableRLS();

export const devices = pgTable(
  "devices",
  {
    serial: text("serial").primaryKey(),
    projectId: projectRef(),
    name: text("name"),
    model: text("model"),
    active: boolean("active"),
    meta: jsonb("meta").$type<Meta>().notNull(),
    ...timestamps,
  },
  (table) => [readableByMembers("devices_select_member", memberOf(table.projectId))],
).enableRLS();

export const recordings = pgTable(
  "recordings",
  {
    name: text("name").primaryKey(),
    projectId: projectRef(),
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
  },
  (table) => [
    index("recordings_project_id").on(table.projectId),
    readableByMembers("recordings_select_member", memberOf(table.projectId)),
  ],
).enableRLS();

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
  (table) => [
    uniqueIndex("recording_objects_recording_name_name").on(table.recordingName, table.name),
    readableByMembers("recording_objects_select_member", memberOfRecording(table.recordingName)),
  ],
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
    readableByMembers("recording_events_select_member", memberOfRecording(table.recordingName)),
  ],
).enableRLS();
