import { isRelayArgv, run } from "./cli.ts";
import { cleanupAfterUpdate } from "./self-update.ts";

// The core and the relay are started in the background, the relay by the browser on every launch.
// They must stay fast and silent, so they skip the update cleanup and leave stdout alone.
const background = process.argv[2] === "--core" || isRelayArgv(process.argv.slice(2));

// Remove the old program an update left beside this one. Best effort, never blocks.
if (!background) void cleanupAfterUpdate();

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
    core: async () => (await import("./core/run-core.ts")).runDefaultCore(),
    relay: async () => (await import("./core/relay.ts")).runDefaultRelay(),
  },
);

// The background modes can leave pipes and timers open (the core may even return at once after
// relaunching itself hidden). Leave explicitly so nothing keeps the process alive.
if (background) process.exit(process.exitCode);
