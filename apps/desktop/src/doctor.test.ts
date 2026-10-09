import { BinaryNotFoundError, type Tool } from "@mediaforge/binary-resolver";
import { describe, expect, it } from "vitest";
import { bundledBinDir, requireTool } from "./binaries.ts";
import { runDoctor } from "./doctor.ts";
import { CliError, ExitCode } from "./exit-codes.ts";

const found = async (tool: Tool) => ({
  tool,
  path: `/bin/${tool}`,
  source: "path" as const,
  version: "1.0",
});
const missing = async (tool: Tool): Promise<never> => {
  throw new BinaryNotFoundError(tool, ["PATH"]);
};
const noRuntime = async () => undefined;

function capture() {
  const chunks: string[] = [];
  return {
    io: { stdout: (t: string) => chunks.push(t), stderr: () => {} },
    out: () => chunks.join(""),
  };
}

describe("runDoctor", () => {
  it("lists both tools and exits 0 when found", async () => {
    const c = capture();
    expect(await runDoctor([], c.io, found, "/bin", noRuntime)).toBe(ExitCode.Ok);
    expect(c.out()).toContain("yt-dlp");
    expect(c.out()).toContain("ffmpeg");
    expect(c.out()).toContain("1.0  (path)");
  });

  it("reports every tool then exits 3 when one is missing", async () => {
    const c = capture();
    const resolve = (tool: Tool) => (tool === "ffmpeg" ? missing(tool) : found(tool));
    expect(await runDoctor([], c.io, resolve, "/bin", noRuntime)).toBe(ExitCode.MissingTool);
    expect(c.out()).toContain("yt-dlp");
    expect(c.out()).toContain("NOT FOUND");
    expect(c.out()).toContain("MEDIAFORGE_FFMPEG_PATH");
  });

  it("prints JSON with --json", async () => {
    const c = capture();
    const code = await runDoctor(["--json"], c.io, found, "/bin", noRuntime);
    const parsed = JSON.parse(c.out());
    expect(code).toBe(ExitCode.Ok);
    expect(parsed.ok).toBe(true);
    expect(parsed.tools).toHaveLength(3);
  });

  it("rejects unknown options with a usage error", async () => {
    const c = capture();
    await expect(runDoctor(["--nope"], c.io, found, "/bin", noRuntime)).rejects.toMatchObject({
      exitCode: ExitCode.Usage,
    });
  });

  it("reports the JS runtime it found, in text and in JSON", async () => {
    const runtime = async () => ({
      name: "node" as const,
      path: "/usr/bin/node",
      version: "v22.1.0",
    });
    const text = capture();
    await runDoctor([], text.io, found, "/bin", runtime);
    expect(text.out()).toContain("js runtime  node  v22.1.0  /usr/bin/node");

    const json = capture();
    await runDoctor(["--json"], json.io, found, "/bin", runtime);
    expect(JSON.parse(json.out()).jsRuntime).toEqual({
      found: true,
      name: "node",
      path: "/usr/bin/node",
      version: "v22.1.0",
    });
  });

  it("warns, without failing, when there is no JS runtime", async () => {
    const c = capture();
    expect(await runDoctor([], c.io, found, "/bin", noRuntime)).toBe(ExitCode.Ok);
    expect(c.out()).toContain("js runtime  NOT FOUND (optional)");
    expect(c.out()).toContain("downloads deno");
    const json = capture();
    await runDoctor(["--json"], json.io, found, "/bin", noRuntime);
    expect(JSON.parse(json.out()).jsRuntime).toEqual({ found: false });
  });
});

describe("runDoctor with deno", () => {
  const withoutDeno = async (tool: Tool) => (tool === "deno" ? missing(tool) : found(tool));

  it("treats a missing deno as optional: exit 0, flagged in text and JSON", async () => {
    const text = capture();
    expect(await runDoctor([], text.io, withoutDeno, "/bin", noRuntime)).toBe(ExitCode.Ok);
    expect(text.out()).toContain("deno     NOT FOUND (optional)");
    const json = capture();
    expect(await runDoctor(["--json"], json.io, withoutDeno, "/bin", noRuntime)).toBe(ExitCode.Ok);
    expect(JSON.parse(json.out()).ok).toBe(true);
  });

  it("still exits 3 when a required tool is missing", async () => {
    const noFfmpeg = async (tool: Tool) => (tool === "ffmpeg" ? missing(tool) : found(tool));
    expect(await runDoctor([], capture().io, noFfmpeg, "/bin", noRuntime)).toBe(
      ExitCode.MissingTool,
    );
  });
});

describe("requireTool", () => {
  it("turns a missing binary into a MissingTool CliError with a hint", async () => {
    const error = await requireTool("yt-dlp", missing).catch((e) => e);
    expect(error).toBeInstanceOf(CliError);
    expect(error.exitCode).toBe(ExitCode.MissingTool);
    expect(error.message).toContain("MEDIAFORGE_YTDLP_PATH");
  });
});

describe("bundledBinDir", () => {
  const base = { env: {}, moduleDir: "/repo/apps/desktop/src" };

  it("prefers MEDIAFORGE_BIN_DIR", () => {
    expect(
      bundledBinDir({ ...base, env: { MEDIAFORGE_BIN_DIR: "/custom" }, execPath: "/x/mediaforge" }),
    ).toBe("/custom");
  });

  it("uses bin/ next to a packaged executable", () => {
    expect(bundledBinDir({ ...base, execPath: "/opt/mf/mediaforge" })).toMatch(/mf[\\/]bin$/);
  });

  it("uses the repo-root bin/ when running through node", () => {
    expect(bundledBinDir({ ...base, execPath: "C:\\nodejs\\node.exe" })).toMatch(/repo[\\/]bin$/);
  });
});
