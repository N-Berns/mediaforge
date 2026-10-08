import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  defaultInstallDeps,
  installTool,
  resolveTarget,
  resolveYtDlpSource,
} from "../../packages/binary-resolver/src/index.ts";
import { createSmokeServer, FAKE_TAG } from "./smoke-server.mjs";
import { TARGETS } from "./targets.mjs";

const sha = (data) => createHash("sha256").update(data).digest("hex");
let server;
let base;

beforeAll(async () => {
  server = createSmokeServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
afterAll(() => new Promise((resolve) => server.close(resolve)));

describe("fake yt-dlp repository", () => {
  it.each([
    ["win32", "x64"],
    ["linux", "x64"],
    ["linux", "arm64"],
    ["darwin", "arm64"],
  ])("is understood by the real client for %s %s", async (platform, arch) => {
    const source = await resolveYtDlpSource(resolveTarget(platform, arch), fetch, `${base}/repo`);
    expect(source.version).toBe(FAKE_TAG);
    expect(source.url.startsWith(`${base}/repo/releases/download/${FAKE_TAG}/`)).toBe(true);
  });

  it("can be installed from by the real installer, into a folder with spaces", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mf smoke "));
    try {
      const result = await installTool(
        { tool: "yt-dlp", target: resolveTarget(), dir },
        { ...defaultInstallDeps(), ytDlpRepoUrl: `${base}/repo` },
      );
      expect(result.version).toBe(FAKE_TAG);
      expect(await readFile(result.path, "utf8")).toBe("not a real yt-dlp\n");
      expect(JSON.parse(await readFile(join(dir, "manifest.json"), "utf8"))["yt-dlp"].version).toBe(
        FAKE_TAG,
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("fake MediaForge release", () => {
  it("serves SHA256SUMS that match every binary", async () => {
    const sums = await (await fetch(`${base}/release/SHA256SUMS`)).text();
    for (const target of TARGETS) {
      const body = Buffer.from(await (await fetch(`${base}/release/${target.file}`)).arrayBuffer());
      expect(sums).toContain(`${sha(body)}  ${target.file}`);
    }
  });

  it("serves binaries that do not match under /corrupt", async () => {
    const sums = await (await fetch(`${base}/corrupt/SHA256SUMS`)).text();
    const target = TARGETS[1];
    const body = Buffer.from(await (await fetch(`${base}/corrupt/${target.file}`)).arrayBuffer());
    expect(sums).not.toContain(sha(body));
    expect((await fetch(`${base}/nope`)).status).toBe(404);
  });
});
