import { describe, expect, it } from "vitest";
import { loadEnv } from "../src/env.js";

const CORE = {
  PROJECT_ID: "00000000-0000-4000-8000-000000000001",
  SUPABASE_URL: "https://example.supabase.co",
  SUPABASE_SERVICE_ROLE_KEY: "service-role-key",
  DATABASE_URL: "postgresql://example",
} as const;

const AXIS = {
  CD_PUBLIC_URL: "http://192.168.1.10:8080",
  CD_USERNAME: "traced",
  CD_PASSWORD: "at-least-8-chars",
  CD_TOKEN_SECRET: "at-least-16-characters",
} as const;

function load(extra: Record<string, string>) {
  return loadEnv({ ...CORE, ...extra } as NodeJS.ProcessEnv);
}

describe("loadEnv", () => {
  it("runs without the Axis wire when it is switched off", () => {
    const env = load({ AXIS_ENABLED: "false", ANALYSIS_ENABLED: "false" });
    expect(env.axis.enabled).toBe(false);
    expect(env.analysis.enabled).toBe(false);
  });

  it("starts with the wire off even when blank Axis values are left in place", () => {
    const env = load({
      AXIS_ENABLED: "false",
      ANALYSIS_ENABLED: "false",
      CD_PUBLIC_URL: "",
      CD_USERNAME: "",
      CD_PASSWORD: "  ",
      CD_TOKEN_SECRET: "",
    });
    expect(env.axis.enabled).toBe(false);
  });

  it("treats a blank OpenAI key as absent when analysis is off", () => {
    const env = load({ AXIS_ENABLED: "false", ANALYSIS_ENABLED: "false", OPENAI_API_KEY: "" });
    expect(env.analysis.enabled).toBe(false);
  });

  it("falls back to the default when a switch is set but blank", () => {
    const env = load({ AXIS_ENABLED: "", ANALYSIS_ENABLED: "false", ...AXIS });
    expect(env.axis.enabled).toBe(true);
  });

  it("ignores a leftover Axis value that is wrong while the wire is off", () => {
    const env = load({
      AXIS_ENABLED: "false",
      ANALYSIS_ENABLED: "false",
      CD_PUBLIC_URL: "192.168.1.10:8080",
      CD_PASSWORD: "short",
    });
    expect(env.axis.enabled).toBe(false);
  });

  it("still refuses a malformed Axis value while the wire is on", () => {
    expect(() => load({ ...AXIS, CD_PUBLIC_URL: "192.168.1.10:8080", ANALYSIS_ENABLED: "false" })).toThrow(
      /CD_PUBLIC_URL/,
    );
    expect(() => load({ ...AXIS, CD_PASSWORD: "short", ANALYSIS_ENABLED: "false" })).toThrow(/CD_PASSWORD/);
  });

  it("serves the wire when the Axis values are all there", () => {
    const env = load({ ...AXIS, ANALYSIS_ENABLED: "false" });
    expect(env.axis).toMatchObject({ enabled: true, publicUrl: AXIS.CD_PUBLIC_URL, username: AXIS.CD_USERNAME });
  });

  it("names the Axis value that is missing rather than starting without the wire", () => {
    const { CD_TOKEN_SECRET: _omitted, ...rest } = AXIS;
    expect(() => load({ ...rest, ANALYSIS_ENABLED: "false" })).toThrow(/CD_TOKEN_SECRET/);
  });

  it("calls a blank Axis value missing rather than malformed while the wire is on", () => {
    expect(() => load({ ...AXIS, CD_PASSWORD: "", ANALYSIS_ENABLED: "false" })).toThrow(
      /CD_PASSWORD is required/,
    );
  });

  it("keeps the documented default when a tuning value is set but blank", () => {
    const env = load({ AXIS_ENABLED: "false", ANALYSIS_ENABLED: "false", ANALYSIS_SCENE_THRESHOLD: "" });
    expect(env.ANALYSIS_SCENE_THRESHOLD).toBe(0.4);
  });
});
