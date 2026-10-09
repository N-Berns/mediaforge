import { run } from "./cli.ts";
import { cleanupAfterUpdate } from "./self-update.ts";

// Remove the old program an update left beside this one. Best effort, never blocks.
void cleanupAfterUpdate();

const inTerminal = Boolean(process.stdin.isTTY && process.stdout.isTTY);

process.exitCode = await run(
  process.argv.slice(2),
  {
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
  },
  {
    // Loaded on demand so scripted commands never pay for the prompt library.
    interactive: inTerminal
      ? async () => (await import("./interactive/start.tsx")).startInteractive()
      : undefined,
  },
);
