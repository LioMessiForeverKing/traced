import { type SQL, sql } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import {
  bigint,
  boolean,
  check,
  doublePrecision,
  index,
  integer,
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
import { UPLOAD_NAME_PREFIX } from "../uploads.js";

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

function accessTo(project: AnyPgColumn) {
  return sql`${signedIn} and public.has_project_access(${project})`;
}

function accessToRecording(recording: AnyPgColumn) {
  return sql`${signedIn} and public.has_recording_access(${recording})`;
}

const platformAdmin = sql`${signedIn} and public.is_admin()`;

const uploadPrefix = sql.raw(`'${UPLOAD_NAME_PREFIX}'`);

function uploadInProgress(recording: AnyPgColumn) {
  return sql`${platformAdmin} and exists (select 1 from public.recordings r where r.name = ${recording} and r.source = 'upload' and r.status = 'uploading')`;
}

function selectPolicy(name: string, predicate: SQL) {
  return pgPolicy(name, { as: "permissive", for: "select", to: authenticatedRole, using: predicate });
}

function insertPolicy(name: string, predicate: SQL) {
  return pgPolicy(name, { as: "permissive", for: "insert", to: authenticatedRole, withCheck: predicate });
}

/** What keeps the flip to one column is the `REVOKE UPDATE` / `GRANT UPDATE (status)` pair in
 * `drizzle/0009`, not this policy: RLS cannot compare a new row against the old one. Drizzle
 * cannot express a column grant, so the schema alone would build a database without it. */
function updatePolicy(name: string, using: SQL, withCheck: SQL) {
  return pgPolicy(name, { as: "permissive", for: "update", to: authenticatedRole, using, withCheck });
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
  (table) => [selectPolicy("projects_select_access", accessTo(table.id))],
);

export const platformAdmins = pgTable(
  "platform_admins",
  {
    userId: uuid("user_id")
      .primaryKey()
      .references(() => authUsers.id, { onDelete: "cascade" }),
    ...timestamps,
  },
  () => [selectPolicy("platform_admins_select_admin", platformAdmin)],
);

export const recordingSources = ["axis", "upload"] as const;

export type RecordingSource = (typeof recordingSources)[number];

export const projectRoles = ["member", "viewer"] as const;

export type ProjectRole = (typeof projectRoles)[number];

export const projectMembers = pgTable(
  "project_members",
  {
    projectId: projectRef(),
    userId: uuid("user_id")
      .notNull()
      .references(() => authUsers.id, { onDelete: "cascade" }),
    role: text("role").$type<ProjectRole>().notNull().default("member"),
    ...timestamps,
  },
  (table) => [
    primaryKey({ columns: [table.projectId, table.userId] }),
    check("project_members_role", sql`${table.role} in ('member', 'viewer')`),
    selectPolicy("project_members_select_member", memberOf(table.projectId)),
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
  (table) => [selectPolicy("bws_systems_select_member", memberOf(table.projectId))],
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
  (table) => [selectPolicy("camera_users_select_member", memberOf(table.projectId))],
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
  (table) => [selectPolicy("devices_select_member", memberOf(table.projectId))],
).enableRLS();

export const recordings = pgTable(
  "recordings",
  {
    name: text("name").primaryKey(),
    projectId: projectRef(),
    source: text("source").$type<RecordingSource>().notNull().default("axis"),
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
    analysisAttempts: integer("analysis_attempts").notNull().default(0),
    analysisError: text("analysis_error"),
    analysedAt: timestamp("analysed_at", { withTimezone: true }),
    meta: jsonb("meta").$type<Meta>().notNull(),
    ...timestamps,
  },
  (table) => [
    index("recordings_project_id").on(table.projectId),
    check("recordings_source", sql`${table.source} in ('axis', 'upload')`),
    selectPolicy("recordings_select_access", accessTo(table.projectId)),
    insertPolicy(
      "recordings_insert_upload_admin",
      sql`${platformAdmin} and ${table.source} = 'upload' and starts_with(${table.name}, ${uploadPrefix})
        and ${table.status} = 'uploading' and ${table.completedAt} is not null
        and ${table.analysisStatus} = 'pending' and ${table.analysisAttempts} = 0
        and ${table.analysedAt} is null and ${table.analysisError} is null`,
    ),
    updatePolicy(
      "recordings_update_upload_complete",
      sql`${platformAdmin} and ${table.source} = 'upload' and ${table.status} = 'uploading'`,
      sql`${table.status} = 'complete'
        and exists (select 1 from public.recording_objects o
          join storage.objects b on b.bucket_id = 'recordings' and b.name = o.storage_path
          where o.recording_name = ${table.name} and o.kind = 'clip')`,
    ),
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
    selectPolicy("recording_objects_select_member", memberOfRecording(table.recordingName)),
    insertPolicy(
      "recording_objects_insert_upload_admin",
      sql`${uploadInProgress(table.recordingName)} and ${table.storagePath} = ${table.recordingName} || '/' || ${table.name}`,
    ),
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
    selectPolicy("recording_events_select_access", accessToRecording(table.recordingName)),
  ],
).enableRLS();
