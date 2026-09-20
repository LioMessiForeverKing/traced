import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const CORE = ["src/analysis", "src/db", "src/store.ts"];
const IMPORTS_AXIS = /from\s+"[^"]*axis[/]/;

async function sources(path: string): Promise<string[]> {
  if (path.endsWith(".ts")) return [path];
  const entries = await readdir(path, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map((entry) => sources(join(path, entry.name))),
  );
  return nested.flat();
}

describe("module boundaries", () => {
  it("keeps the core clear of the Axis module", async () => {
    const files = (await Promise.all(CORE.map(sources))).flat();
    expect(files.length).toBeGreaterThan(4);
    const offenders: string[] = [];
    for (const file of files) {
      const body = await readFile(file, "utf8");
      if (IMPORTS_AXIS.test(body)) offenders.push(file);
    }
    expect(offenders).toEqual([]);
  });
});
