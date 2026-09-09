CREATE TABLE "recording_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"recording_name" text NOT NULL,
	"offset_seconds" double precision NOT NULL,
	"occurred_at" timestamp with time zone,
	"system" text,
	"zone" text,
	"description" text NOT NULL,
	"confidence" real NOT NULL,
	"frame_offsets" double precision[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "recording_events" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "recordings" ADD COLUMN "analysis_status" text DEFAULT 'pending' NOT NULL;--> statement-breakpoint
ALTER TABLE "recordings" ADD COLUMN "analysis_error" text;--> statement-breakpoint
ALTER TABLE "recordings" ADD COLUMN "analysed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "recording_events" ADD CONSTRAINT "recording_events_recording_name_recordings_name_fk" FOREIGN KEY ("recording_name") REFERENCES "public"."recordings"("name") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "recording_events_recording_name" ON "recording_events" USING btree ("recording_name");--> statement-breakpoint
CREATE INDEX "recording_events_occurred_at" ON "recording_events" USING btree ("occurred_at");