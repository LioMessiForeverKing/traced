CREATE TABLE "bws_systems" (
	"id" text PRIMARY KEY NOT NULL,
	"connection_id" text,
	"system_name" text,
	"meta" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "bws_systems" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "camera_users" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text,
	"user_id" text,
	"active" boolean,
	"meta" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "camera_users" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "devices" (
	"serial" text PRIMARY KEY NOT NULL,
	"name" text,
	"model" text,
	"active" boolean,
	"meta" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "devices" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "recording_objects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"recording_name" text NOT NULL,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"storage_path" text NOT NULL,
	"content_type" text,
	"size_bytes" bigint,
	"start_time" timestamp with time zone,
	"stop_time" timestamp with time zone,
	"meta" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "recording_objects" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "recordings" (
	"name" text PRIMARY KEY NOT NULL,
	"user_id" text,
	"device_serial" text,
	"status" text NOT NULL,
	"trigger_on" text,
	"trigger_off" text,
	"trigger_on_time" timestamp with time zone,
	"trigger_off_time" timestamp with time zone,
	"start_time" timestamp with time zone,
	"stop_time" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"meta" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "recordings" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "recording_objects" ADD CONSTRAINT "recording_objects_recording_name_recordings_name_fk" FOREIGN KEY ("recording_name") REFERENCES "public"."recordings"("name") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "recording_objects_recording_name_name" ON "recording_objects" USING btree ("recording_name","name");