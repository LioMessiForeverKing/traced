import OpenAI from "openai";
import { zodTextFormat } from "openai/helpers/zod";
import { z } from "zod";
import type { Frame } from "./frames.js";

export const SYSTEMS = [
  "Framing",
  "Plumbing",
  "Electrical",
  "Concrete",
  "Waterproofing",
  "HVAC",
  "Fire suppression",
  "Unknown",
] as const;

export interface ExtractInput {
  recording: string;
  startTime: Date | null;
  frames: Frame[];
}

export interface ExtractedEvent {
  frameIndexes: number[];
  system: string | null;
  zone: string | null;
  description: string;
  confidence: number;
}

export interface EventExtractor {
  extract(input: ExtractInput): Promise<ExtractedEvent[]>;
}

export interface ExtractorConfig {
  apiKey: string;
  model: string;
}

const MAX_OUTPUT_TOKENS = 16_000;

const ResultSchema = z.object({
  events: z.array(
    z.object({
      frame_indexes: z.array(z.number().int()),
      system: z.enum(SYSTEMS),
      zone: z.string(),
      description: z.string(),
      confidence: z.number(),
    }),
  ),
});

const INSTRUCTIONS = `You are reviewing still frames pulled from one body worn camera recording made by a construction worker. The frames are in chronological order and each is labelled with its index and its offset in seconds from the start of the recording.

Report the discrete, observable work events the frames document. An event is something a worker did, or a condition of the work, that an insurance adjuster reading this record years later would care about: an installation, an inspection, a concrete pour, a connection made, a hazard, a defect, a protective measure taken. Do not report the camera moving, the worker walking between areas, conversation, breaks, or generic site activity.

Rules:
- Cite the frames that evidence each event by their index. Every event needs at least one.
- Describe only what is visible. Never infer work that happens off camera.
- system must be one of the listed building systems, or "Unknown" when the frames do not make it legible.
- zone is the area of the building if a sign, level marker or drawing in frame identifies it. Use an empty string when nothing in frame identifies it. Never guess a zone.
- confidence runs 0 to 1 and is how sure you are the event happened as described.
- Return an empty list when the frames document no work worth recording. An empty record is a correct answer.`;

export function createOpenAiExtractor(config: ExtractorConfig): EventExtractor {
  const client = new OpenAI({ apiKey: config.apiKey });

  return {
    async extract(input) {
      const frames: OpenAI.Responses.ResponseInputContent[] = input.frames.flatMap((frame, index) => [
        { type: "input_text", text: `frame ${index} — t=${frame.offsetSeconds.toFixed(1)}s` },
        {
          type: "input_image",
          image_url: `data:image/jpeg;base64,${frame.jpeg.toString("base64")}`,
          detail: "auto",
        },
      ]);

      const response = await client.responses.parse({
        model: config.model,
        max_output_tokens: MAX_OUTPUT_TOKENS,
        input: [
          { role: "system", content: INSTRUCTIONS },
          {
            role: "user",
            content: [
              ...frames,
              {
                type: "input_text",
                text: `Recording ${input.recording}, started ${input.startTime?.toISOString() ?? "at an unrecorded time"}. Report the work events these ${input.frames.length} frames document.`,
              },
            ],
          },
        ],
        text: { format: zodTextFormat(ResultSchema, "events") },
      });

      if (response.status !== "completed") {
        throw new Error(
          `openai returned ${response.status}: ${response.incomplete_details?.reason ?? "no reason given"}`,
        );
      }
      if (!response.output_parsed) {
        throw new Error(`openai returned no parseable events: ${response.output_text.slice(0, 200)}`);
      }

      return response.output_parsed.events.map((event) => ({
        frameIndexes: event.frame_indexes,
        system: event.system === "Unknown" ? null : event.system,
        zone: event.zone.trim() === "" ? null : event.zone.trim(),
        description: event.description,
        confidence: event.confidence,
      }));
    },
  };
}
