import { type ProjectRole, projectRoles } from "../src/db/schema.js";

export type GrantArgs =
  | { kind: "project"; email: string; projectId?: string; role?: ProjectRole }
  | { kind: "admin"; email: string }
  | { kind: "invalid"; problem: string };

export const USAGE = [
  `usage: npm run grant-access -- <email> [projectId] [--role ${projectRoles.join("|")}]`,
  "       npm run grant-access -- <email> --admin",
].join("\n");

function asRole(value: string): ProjectRole | undefined {
  return projectRoles.find((candidate) => candidate === value);
}

export function parseGrantArgs(argv: readonly string[]): GrantArgs {
  const positional: string[] = [];
  let roleValue: string | undefined;
  let sawRole = false;
  let admin = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--admin") {
      admin = true;
    } else if (arg === "--role") {
      if (sawRole) return { kind: "invalid", problem: "--role was given twice" };
      sawRole = true;
      roleValue = argv[index + 1];
      index += 1;
    } else if (arg.startsWith("--")) {
      return { kind: "invalid", problem: `not an option: ${arg}` };
    } else {
      positional.push(arg);
    }
  }

  const [email, projectId] = positional;
  if (!email) return { kind: "invalid", problem: "an email address is required" };

  if (admin && sawRole) {
    return {
      kind: "invalid",
      problem: "--admin and --role are different things: an admin is above projects, not a role in one",
    };
  }
  if (admin && positional.length > 1) {
    return {
      kind: "invalid",
      problem: `--admin takes no project id, but got ${positional[1]}: an admin already reads every project`,
    };
  }
  if (admin) return { kind: "admin", email };

  if (positional.length > 2) {
    return { kind: "invalid", problem: `too many arguments: ${positional.slice(2).join(" ")}` };
  }
  if (!sawRole) return { kind: "project", email, projectId };

  if (roleValue === undefined) return { kind: "invalid", problem: "--role needs a value" };
  const role = asRole(roleValue);
  if (!role) return { kind: "invalid", problem: `not a project role: ${roleValue}` };
  return { kind: "project", email, projectId, role };
}
