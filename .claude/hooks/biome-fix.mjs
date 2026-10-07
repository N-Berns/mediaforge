// PostToolUse hook: run Biome (lint + format + safe fixes) on every file Claude writes or edits.
// Exit 2 with diagnostics on stderr when issues remain, so Claude must fix them.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

let raw = "";
for await (const chunk of process.stdin) raw += chunk;

let input;
try {
  input = JSON.parse(raw);
} catch {
  process.exit(0);
}

const file = input.tool_input?.file_path ?? input.tool_input?.notebook_path;
if (!file) process.exit(0);

const root = process.env.CLAUDE_PROJECT_DIR ?? process.cwd();
const target = resolve(root, file);
if (!existsSync(target)) process.exit(0);

const result = spawnSync(
  "pnpm",
  [
    "exec",
    "biome",
    "check",
    "--write",
    "--no-errors-on-unmatched",
    "--files-ignore-unknown=true",
    "--colors=off",
    target,
  ],
  { cwd: root, encoding: "utf8", shell: true },
);

if (result.status !== 0) {
  process.stderr.write(
    `Biome found issues in ${file} that could not be auto-fixed. Fix them now:\n` +
      `${result.stdout}${result.stderr}`,
  );
  process.exit(2);
}
