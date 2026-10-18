import { describe, expect, it, vi } from "vitest";
import {
  linuxTerminalArgs,
  managerCommand,
  OPEN_SCRIPT,
  openManagerTerminal,
} from "./open-terminal.ts";

const EXE = "C:\\MediaForge\\mediaforge.exe";

const deps = (
  platform: NodeJS.Platform,
  env: Record<string, string | undefined>,
  run: (command: string, args: string[]) => Promise<boolean>,
) => ({
  platform,
  env,
  execPath: EXE,
  argv1: undefined,
  run: vi.fn(run),
});

describe("managerCommand", () => {
  it("runs the script through node in development", () => {
    expect(managerCommand("C:\\Program Files\\nodejs\\node.exe", "E:\\a b\\main.js")).toEqual({
      command: "C:\\Program Files\\nodejs\\node.exe",
      args: ["E:\\a b\\main.js", "--manager"],
    });
  });

  it("runs the packaged exe directly", () => {
    expect(managerCommand(EXE, "x")).toEqual({ command: EXE, args: ["--manager"] });
  });
});

describe("linuxTerminalArgs", () => {
  it("uses each terminal's own way to run a command", () => {
    expect(linuxTerminalArgs("/usr/bin/gnome-terminal", "mf", ["--manager"])).toEqual([
      "--",
      "mf",
      "--manager",
    ]);
    expect(linuxTerminalArgs("xfce4-terminal", "mf", ["--manager"])).toEqual([
      "-x",
      "mf",
      "--manager",
    ]);
    expect(linuxTerminalArgs("konsole", "mf", ["--manager"])).toEqual(["-e", "mf", "--manager"]);
  });
});

describe("openManagerTerminal", () => {
  it("starts PowerShell on Windows, passing the command in the environment", async () => {
    const d = deps("win32", { SystemRoot: "D:\\Win" }, async () => true);
    expect(await openManagerTerminal(d)).toBe("launched");
    expect(d.run).toHaveBeenCalledTimes(1);
    const [file, args, env] = d.run.mock.calls[0] as unknown as [
      string,
      string[],
      Record<string, string>,
    ];
    expect(file).toBe("D:\\Win\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
    expect(args).toEqual(["-NoProfile", "-NonInteractive", "-Command", OPEN_SCRIPT]);
    expect(env.MEDIAFORGE_OPEN_FILE).toBe(EXE);
    expect(env.MEDIAFORGE_OPEN_ARGS).toBe(JSON.stringify(["--manager"]));
    expect(OPEN_SCRIPT).not.toContain(EXE);
    expect(OPEN_SCRIPT).not.toContain("--manager");
  });

  it("reports no terminal when PowerShell fails", async () => {
    const d = deps("win32", {}, async () => false);
    expect(await openManagerTerminal(d)).toBe("no-terminal");
  });

  it("reports no terminal when the launch rejects on Windows", async () => {
    const d = deps("win32", {}, async () => {
      throw new Error("boom");
    });
    expect(await openManagerTerminal(d)).toBe("no-terminal");
  });

  it("tries $TERMINAL first on Linux", async () => {
    const d = deps("linux", { TERMINAL: "kitty" }, async (command) => command === "kitty");
    expect(await openManagerTerminal(d)).toBe("launched");
    expect(d.run.mock.calls[0]?.slice(0, 2)).toEqual(["kitty", ["-e", EXE, "--manager"]]);
  });

  it("walks the terminal list on Linux and gives up when none starts", async () => {
    const d = deps("linux", {}, async () => false);
    expect(await openManagerTerminal(d)).toBe("no-terminal");
    expect(d.run.mock.calls.map((call) => call[0])).toEqual([
      "x-terminal-emulator",
      "gnome-terminal",
      "konsole",
      "xfce4-terminal",
      "xterm",
    ]);
  });

  it("moves on to the next terminal when a launch rejects", async () => {
    const d = deps("linux", {}, async (command) => {
      if (command === "x-terminal-emulator") throw new Error("boom");
      return command === "gnome-terminal";
    });
    expect(await openManagerTerminal(d)).toBe("launched");
    expect(d.run.mock.calls.map((call) => call[0])).toEqual([
      "x-terminal-emulator",
      "gnome-terminal",
    ]);
  });

  it("does nothing on other platforms", async () => {
    const d = deps("darwin", {}, async () => true);
    expect(await openManagerTerminal(d)).toBe("no-terminal");
    expect(d.run).not.toHaveBeenCalled();
  });
});
