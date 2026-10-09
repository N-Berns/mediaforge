import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { crc32 } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { installTool } from "./install.ts";
import type { ToolsLock } from "./lock.ts";
import { defaultInstallDeps, realInstallFs, tarExtract } from "./node-adapters.ts";
import { resolveTarget, targetKey } from "./target.ts";
import { routeFetch } from "./test-helpers.ts";

const run = promisify(execFile);
let root: string;

// A folder name with spaces and non-ASCII letters, like some Windows user profiles.
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "mf José Núñez "));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/** Build `archive.tar` containing pkg-1/bin/ffmpeg, using the system tar with relative paths. */
async function makeTar(content: string): Promise<string> {
  await mkdir(join(root, "src", "pkg-1", "bin"), { recursive: true });
  await writeFile(join(root, "src", "pkg-1", "bin", "ffmpeg"), content);
  await run("tar", ["-cf", "archive.tar", "-C", "src", "."], { cwd: root });
  return join(root, "archive.tar");
}

/** Build `archive.zip` holding one stored (uncompressed) file, so no zip tool is needed. */
async function makeZip(name: string, content: string): Promise<string> {
  const nameBytes = Buffer.from(name);
  const data = Buffer.from(content);
  const crc = crc32(data);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(data.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(nameBytes.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(data.length, 20);
  central.writeUInt32LE(data.length, 24);
  central.writeUInt16LE(nameBytes.length, 28);
  const localSize = local.length + nameBytes.length + data.length;
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length + nameBytes.length, 12);
  end.writeUInt32LE(localSize, 16);
  const path = join(root, "archive.zip");
  await writeFile(path, Buffer.concat([local, nameBytes, data, central, nameBytes, end]));
  return path;
}

describe("realInstallFs", () => {
  it("writes in chunks, hashes, lists, renames and removes", async () => {
    const dir = join(root, "a", "b");
    await realInstallFs.mkdir(dir);
    const file = await realInstallFs.openWrite(join(dir, "x.bin"));
    await file.write(new TextEncoder().encode("hello "));
    await file.write(new TextEncoder().encode("world"));
    await file.close();

    expect(await realInstallFs.sha256File(join(dir, "x.bin"))).toBe(
      createHash("sha256").update("hello world").digest("hex"),
    );
    expect(await realInstallFs.listFiles(join(root, "a"))).toEqual(["b/x.bin"]);

    await realInstallFs.rename(join(dir, "x.bin"), join(dir, "y.bin"));
    expect(await realInstallFs.exists(join(dir, "x.bin"))).toBe(false);
    expect(await realInstallFs.readText(join(dir, "y.bin"))).toBe("hello world");

    await realInstallFs.rm(join(root, "a"));
    await realInstallFs.rm(join(root, "a"));
    expect(await realInstallFs.exists(join(root, "a"))).toBe(false);
  });
});

describe("tarExtract", () => {
  it("unpacks an archive into the destination", async () => {
    const archive = await makeTar("FFMPEG");
    const out = join(root, "out");
    await mkdir(out);
    await tarExtract(archive, out, "tar");
    expect(await realInstallFs.listFiles(out)).toContain("pkg-1/bin/ffmpeg");
  });

  it("unpacks a zip archive (deno ships as zip on every OS)", async () => {
    const archive = await makeZip("deno", "DENO");
    const out = join(root, "out");
    await mkdir(out);
    await tarExtract(archive, out, "zip");
    expect(await readFile(join(out, "deno"), "utf8")).toBe("DENO");
  });

  it("rejects with tar's message when the archive is unreadable", async () => {
    await mkdir(join(root, "out"));
    await expect(tarExtract(join(root, "missing.tar"), join(root, "out"), "tar")).rejects.toThrow();
  });
});

describe("installTool with the real adapters", () => {
  it("installs ffmpeg from a tar archive into a folder with spaces and accents", async () => {
    const archive = await makeTar("REAL-FFMPEG");
    const bytes = await readFile(archive);
    const key = targetKey(resolveTarget());
    const lock: ToolsLock = {
      schema: 1,
      deno: {},
      ffmpeg: {
        [key]: {
          version: "9.9",
          url: "https://example.test/ffmpeg.tar",
          sha256: createHash("sha256").update(bytes).digest("hex"),
          archive: "tar",
          member: "bin/ffmpeg",
          license: "LGPL-2.1-or-later",
          buildInfo: "https://example.test",
        },
      },
    };
    const dir = join(root, "Mädia Förge", "bin");
    const result = await installTool(
      { tool: "ffmpeg", target: resolveTarget(), dir },
      {
        ...defaultInstallDeps(),
        fetch: routeFetch({ "https://example.test/ffmpeg.tar": () => new Response(bytes) }),
        lock,
      },
    );
    expect(await readFile(result.path, "utf8")).toBe("REAL-FFMPEG");
    expect((await realInstallFs.listFiles(dir)).sort()).toEqual([
      expect.stringMatching(/^ffmpeg(\.exe)?$/),
      "manifest.json",
    ]);
  });
});
