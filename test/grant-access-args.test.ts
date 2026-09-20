import { describe, expect, it } from "vitest";
import { parseGrantArgs } from "../scripts/grant-access-args.js";

describe("grant-access arguments", () => {
  it("grants project membership by default", () => {
    expect(parseGrantArgs(["site@example.com"])).toEqual({
      kind: "project",
      email: "site@example.com",
      projectId: undefined,
    });
  });

  it("takes a project id and a role", () => {
    expect(parseGrantArgs(["insurer@example.com", "a-project", "--role", "viewer"])).toEqual({
      kind: "project",
      email: "insurer@example.com",
      projectId: "a-project",
      role: "viewer",
    });
  });

  it("reads --role wherever it appears", () => {
    expect(parseGrantArgs(["--role", "viewer", "insurer@example.com"])).toEqual({
      kind: "project",
      email: "insurer@example.com",
      projectId: undefined,
      role: "viewer",
    });
  });

  it("grants platform admin, which belongs to no project", () => {
    expect(parseGrantArgs(["boss@example.com", "--admin"])).toEqual({
      kind: "admin",
      email: "boss@example.com",
    });
  });

  it("refuses --admin together with --role rather than picking one", () => {
    const parsed = parseGrantArgs(["boss@example.com", "--admin", "--role", "viewer"]);
    expect(parsed.kind).toBe("invalid");
  });

  it("refuses --admin with a project id rather than ignoring it", () => {
    const parsed = parseGrantArgs(["boss@example.com", "a-project", "--admin"]);
    expect(parsed.kind).toBe("invalid");
  });

  it("refuses a role that is not one", () => {
    expect(parseGrantArgs(["someone@example.com", "--role", "admin"]).kind).toBe("invalid");
  });

  it("refuses --role with nothing after it", () => {
    expect(parseGrantArgs(["someone@example.com", "--role"]).kind).toBe("invalid");
  });

  it("refuses an option it does not know", () => {
    expect(parseGrantArgs(["someone@example.com", "--rolle", "viewer"]).kind).toBe("invalid");
  });

  it("refuses arguments it has no use for", () => {
    expect(parseGrantArgs(["someone@example.com", "a-project", "stray"]).kind).toBe("invalid");
  });

  it("refuses no email at all", () => {
    expect(parseGrantArgs([]).kind).toBe("invalid");
    expect(parseGrantArgs(["--role", "viewer"]).kind).toBe("invalid");
  });
});
