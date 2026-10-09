import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { realInstallFs, resolveTarget } from "@mediaforge/binary-resolver";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ExitCode } from "./exit-codes.ts";
import {
  checkForUpdate,
  cleanupAfterUpdate,
  compareVersions,
  installUpdate,
  isPackaged,
  runSelfUpdate,
  type SelfUpdateDeps,
  type UpdateInfo,
} from "./self-update.ts";

const REPO = "https://example.test/N-Berns/mediaforge";
const sha = (text: string) => createHash("sha256").update(text).digest("hex");

type Route = () => Response;

function fakeFetch(routes: Record<string, Route>) {
  return async (url: string) => {
    const route = routes[url];
    return route ? route() : new Response("not found", { status: 404 });
  };
}

const latest = (tag: string): Record<string, Route> => ({
  [`${REPO}/releases/latest`]: () =>
    new Response(null, { status: 302, headers: { location: `${REPO}/releases/tag/${tag}` } }),
});

const release = (
  tag: string,
  asset: string,
  body: string,
  sum = sha(body),
): Record<string, Route> => ({
  ...latest(tag),
  [`${REPO}/releases/download/${tag}/SHA256SUMS`]: () => new Response(`${sum}  ${asset}\n`),
  [`${REPO}/releases/download/${tag}/${asset}`]: () => new Response(body),
});

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "mf update "));
});
afterEach(() => rm(dir, { recursive: true, force: true }));

function deps(routes: Record<string, Route>, extra: Partial<SelfUpdateDeps> = {}): SelfUpdateDeps {
  return {
    fetch: fakeFetch(routes),
    fs: realInstallFs,
    execPath: join(dir, "mediaforge"),
    target: () => resolveTarget("linux", "x64"),
    version: "1.0.0",
    repoUrl: REPO,
    platform: "linux",
    ...extra,
  };
}

const info = (extra: Partial<UpdateInfo> = {}): UpdateInfo => ({
  current: "1.0.0",
  latest: "1.1.0",
  tag: "v1.1.0",
  newer: true,
  installable: true,
  ...extra,
});

describe("compareVersions", () => {
  it("orders numbers, not text, and ranks a pre-release below its release", () => {
    expect(compareVersions("0.10.0", "0.9.0")).toBeGreaterThan(0);
    expect(compareVersions("1.0.0", "1.0.0")).toBe(0);
    expect(compareVersions("v1.2", "1.2.0")).toBe(0);
    expect(compareVersions("1.0.0-rc.2", "1.0.0")).toBeLessThan(0);
    expect(compareVersions("1.0.0", "1.0.0-rc.2")).toBeGreaterThan(0);
    expect(compareVersions("1.0.0-rc.10", "1.0.0-rc.2")).toBeGreaterThan(0);
  });
});

describe("isPackaged", () => {
  it("is false for Node and true for the packaged program", () => {
    expect(isPackaged("/usr/bin/node")).toBe(false);
    expect(isPackaged("C:\\nodejs\\node.exe")).toBe(false);
    expect(isPackaged("/home/a/.local/bin/mediaforge")).toBe(true);
    expect(isPackaged("C:\\MediaForge\\mediaforge.exe")).toBe(true);
  });
});

describe("checkForUpdate", () => {
  it("reads the newest tag from the redirect", async () => {
    const found = await checkForUpdate(deps(latest("v1.1.0")));
    expect(found).toMatchObject({ latest: "1.1.0", tag: "v1.1.0", newer: true, installable: true });
  });

  it("says not newer when equal or older", async () => {
    expect((await checkForUpdate(deps(latest("v1.0.0")))).newer).toBe(false);
    expect((await checkForUpdate(deps(latest("v0.9.0")))).newer).toBe(false);
  });

  it("is not installable through Node", async () => {
    const found = await checkForUpdate(deps(latest("v2.0.0"), { execPath: "/usr/bin/node" }));
    expect(found.installable).toBe(false);
  });

  it("reports an unreachable server and a repo with no release", async () => {
    const offline = deps(
      {},
      {
        fetch: async () => {
          throw new TypeError("fetch failed");
        },
      },
    );
    await expect(checkForUpdate(offline)).rejects.toMatchObject({ kind: "offline" });
    await expect(checkForUpdate(deps({}))).rejects.toMatchObject({ kind: "not-found" });
  });
});

describe("installUpdate", () => {
  it("downloads, verifies and replaces the program, leaving nothing behind", async () => {
    await writeFile(join(dir, "mediaforge"), "OLD");
    const phases: string[] = [];
    await installUpdate(
      info(),
      deps(release("v1.1.0", "mediaforge-linux-x64", "NEW-BINARY")),
      (p) => phases.push(p.phase),
    );
    expect(await readFile(join(dir, "mediaforge"), "utf8")).toBe("NEW-BINARY");
    expect(await readdir(dir)).toEqual(["mediaforge"]);
    expect(phases).toContain("verifying");
    expect(phases.at(-1)).toBe("installing");
  });

  it("keeps the old program and removes the download when the checksum is wrong", async () => {
    await writeFile(join(dir, "mediaforge"), "OLD");
    const bad = release("v1.1.0", "mediaforge-linux-x64", "NEW-BINARY", "0".repeat(64));
    await expect(installUpdate(info(), deps(bad))).rejects.toMatchObject({ kind: "checksum" });
    expect(await readFile(join(dir, "mediaforge"), "utf8")).toBe("OLD");
    expect(await readdir(dir)).toEqual(["mediaforge"]);
  });

  it("fails when SHA256SUMS has no entry for this build", async () => {
    await writeFile(join(dir, "mediaforge"), "OLD");
    const routes = release("v1.1.0", "mediaforge-win-x64.exe", "x");
    await expect(installUpdate(info(), deps(routes))).rejects.toMatchObject({ kind: "no-source" });
  });

  it("on Windows moves the running program aside first, then cleanup removes it", async () => {
    const exe = join(dir, "mediaforge.exe");
    await writeFile(exe, "OLD");
    const windows = deps(release("v1.1.0", "mediaforge-win-x64.exe", "NEW"), {
      execPath: exe,
      platform: "win32",
      target: () => resolveTarget("win32", "x64"),
    });
    await installUpdate(info(), windows);
    expect(await readFile(exe, "utf8")).toBe("NEW");
    expect(await readFile(`${exe}.old`, "utf8")).toBe("OLD");
    await cleanupAfterUpdate(windows);
    expect(await readdir(dir)).toEqual(["mediaforge.exe"]);
  });

  it("refuses when running through Node", async () => {
    await expect(installUpdate(info({ installable: false }), deps({}))).rejects.toMatchObject({
      kind: "unsupported",
    });
  });
});

describe("runSelfUpdate", () => {
  function capture() {
    let out = "";
    let err = "";
    return {
      io: {
        stdout: (t: string) => {
          out += t;
        },
        stderr: (t: string) => {
          err += t;
        },
      },
      out: () => out,
      err: () => err,
    };
  }

  it("says so when already up to date", async () => {
    const c = capture();
    expect(await runSelfUpdate([], c.io, deps(latest("v1.0.0")))).toBe(ExitCode.Ok);
    expect(c.out()).toBe("MediaForge 1.0.0 is up to date.\n");
  });

  it("updates and tells the user to run it again", async () => {
    await writeFile(join(dir, "mediaforge"), "OLD");
    const c = capture();
    const code = await runSelfUpdate(
      [],
      c.io,
      deps(release("v1.1.0", "mediaforge-linux-x64", "NEW")),
    );
    expect(code).toBe(ExitCode.Ok);
    expect(c.out()).toContain("MediaForge updated to 1.1.0");
    expect(await readFile(join(dir, "mediaforge"), "utf8")).toBe("NEW");
  });

  it("maps a missing release to exit 4", async () => {
    await expect(runSelfUpdate([], capture().io, deps({}))).rejects.toMatchObject({
      exitCode: ExitCode.Network,
    });
  });

  it("shows help and rejects extra arguments", async () => {
    const c = capture();
    expect(await runSelfUpdate(["--help"], c.io, deps({}))).toBe(ExitCode.Ok);
    expect(c.out()).toContain("Usage: mediaforge self-update");
    expect(await runSelfUpdate(["now"], capture().io, deps({}))).toBe(ExitCode.Usage);
  });
});
