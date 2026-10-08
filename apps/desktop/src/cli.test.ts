import { describe, expect, it } from "vitest";
import { run } from "./cli.ts";
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
