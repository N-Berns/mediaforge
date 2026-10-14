import { describe, expect, it } from "vitest";
import { isRelayArgv, isRelayInvocation, run } from "./cli.ts";
import { ExitCode } from "./exit-codes.ts";
import { VERSION } from "./version.ts";

async function exec(...argv: string[]) {
  let out = "";
  let err = "";
  const code = await run(argv, {
    stdout: (t) => {
      out += t;
    },
    stderr: (t) => {
      err += t;
    },
  });
  return { code, out, err };
}

describe("run", () => {
  it("prints help and exits 0 with no arguments", async () => {
    const { code, out } = await exec();
    expect(code).toBe(ExitCode.Ok);
    expect(out).toContain("Usage: mediaforge");
    expect(out).toContain("download");
  });

  it("prints help for --help and -h", async () => {
    expect((await exec("--help")).out).toContain("Commands:");
    expect((await exec("-h")).out).toContain("Commands:");
  });

  it("prints the version", async () => {
    expect(await exec("--version")).toEqual({ code: ExitCode.Ok, out: `${VERSION}\n`, err: "" });
  });

  it("exits 2 with help on stderr for an unknown command", async () => {
    const { code, out, err } = await exec("nope");
    expect(code).toBe(ExitCode.Usage);
    expect(out).toBe("");
    expect(err).toContain("Unknown command: nope");
  });

  it("does not list browser host commands", async () => {
    const { out } = await exec("--help");
    expect(out).not.toMatch(/\b(host|install|uninstall)\b/);
  });
});

describe("background modes", () => {
  const io = { stdout: () => {}, stderr: () => {} };

  it("runs the core for --core", async () => {
    let called = 0;
    const code = await run(["--core"], io, {
      core: async () => {
        called++;
        return 0;
      },
    });
    expect(code).toBe(0);
    expect(called).toBe(1);
  });

  it("runs the relay for --native-host and for a Chrome origin argument", async () => {
    let called = 0;
    const relay = async () => {
      called++;
      return 0;
    };
    await run(["--native-host"], io, { relay });
    await run(["chrome-extension://abcdefghijklmnop/", "--parent-window=0"], io, { relay });
    expect(called).toBe(2);
  });

  it("runs the relay for a Firefox origin argument", async () => {
    let called = 0;
    await run(["moz-extension://abcdefghijklmnop/"], io, {
      relay: async () => {
        called++;
        return 0;
      },
    });
    expect(called).toBe(1);
  });

  it("returns the exit code the mode produced", async () => {
    expect(await run(["--core"], io, { core: async () => 7 })).toBe(7);
    expect(await run(["--native-host"], io, { relay: async () => 3 })).toBe(3);
  });

  it("never runs the relay for --core or the core for --native-host", async () => {
    let core = 0;
    let relay = 0;
    const options = {
      core: async () => {
        core++;
        return 0;
      },
      relay: async () => {
        relay++;
        return 0;
      },
    };
    await run(["--core"], io, options);
    expect({ core, relay }).toEqual({ core: 1, relay: 0 });
    await run(["--native-host"], io, options);
    expect({ core, relay }).toEqual({ core: 1, relay: 1 });
  });

  it("keeps both modes out of the help text", async () => {
    const { out } = await exec("--help");
    expect(out).not.toContain("--core");
    expect(out).not.toContain("--native-host");
  });

  it("fails with a usage error when a mode is requested but not available", async () => {
    const { code, err } = await exec("--core");
    expect(code).toBe(ExitCode.Usage);
    expect(err).toContain("--core is not available here");
    expect((await exec("--native-host")).code).toBe(ExitCode.Usage);
  });

  it("returns a failure with a message on stderr when a mode throws", async () => {
    let err = "";
    const code = await run(
      ["--core"],
      {
        stdout: () => {},
        stderr: (t) => {
          err += t;
        },
      },
      {
        core: async () => {
          throw new Error("boom");
        },
      },
    );
    expect(code).toBe(ExitCode.Failure);
    expect(err).toContain("boom");
  });

  it("does not write to stdout in a mode", async () => {
    let out = "";
    await run(
      ["--native-host"],
      {
        stdout: (t) => {
          out += t;
        },
        stderr: () => {},
      },
      { relay: async () => 0 },
    );
    expect(out).toBe("");
  });
});

describe("isRelayInvocation", () => {
  it("accepts the explicit flag and browser extension origins", () => {
    expect(isRelayInvocation("--native-host")).toBe(true);
    expect(isRelayInvocation("chrome-extension://abc/")).toBe(true);
    expect(isRelayInvocation("moz-extension://abc/")).toBe(true);
  });

  it("rejects everything else", () => {
    expect(isRelayInvocation(undefined)).toBe(false);
    expect(isRelayInvocation("--core")).toBe(false);
    expect(isRelayInvocation("download")).toBe(false);
    expect(isRelayInvocation("https://chrome-extension://abc")).toBe(false);
  });
});

describe("isRelayArgv", () => {
  const io = { stdout: () => {}, stderr: () => {} };

  it("accepts Chrome, the explicit flag, and Firefox's manifest path plus add-on id", () => {
    expect(isRelayArgv(["--native-host"])).toBe(true);
    expect(isRelayArgv(["chrome-extension://abc/", "--parent-window=1"])).toBe(true);
    expect(
      isRelayArgv([
        "C:\\Users\\n\\AppData\\Local\\MediaForge\\com.mediaforge.host.json",
        "mediaforge@n-berns",
      ]),
    ).toBe(true);
    expect(
      isRelayArgv(["/home/n/.mozilla/native-messaging-hosts/com.mediaforge.host.json", "id"]),
    ).toBe(true);
  });

  it("does not treat ordinary commands or other json files as relay mode", () => {
    expect(isRelayArgv(["download", "com.mediaforge.host.json"])).toBe(false);
    expect(isRelayArgv(["settings.json", "x"])).toBe(false);
    expect(isRelayArgv(["com.mediaforge.host.json"])).toBe(false);
    expect(isRelayArgv([])).toBe(false);
  });

  it("run() starts the relay for Firefox's argv", async () => {
    let called = 0;
    await run(["C:\\x\\com.mediaforge.host.json", "mediaforge@n-berns"], io, {
      relay: async () => {
        called++;
        return 0;
      },
    });
    expect(called).toBe(1);
  });
});
