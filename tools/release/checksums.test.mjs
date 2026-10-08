import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checksumDir, formatSha256Sums, sha256OfFile } from "./checksums.mjs";

const sha = (text) => createHash("sha256").update(text).digest("hex");
let dir;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "mf-sums-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("formatSha256Sums", () => {
  it("writes '<hash>  <name>' lines sorted by name", () => {
    expect(
      formatSha256Sums([
        { name: "b", sha256: "2" },
        { name: "a", sha256: "1" },
      ]),
    ).toBe("1  a\n2  b\n");
  });
});

describe("checksumDir", () => {
  it("hashes every file except an existing SHA256SUMS", async () => {
    await writeFile(join(dir, "mediaforge-linux-x64"), "AAA");
    await writeFile(join(dir, "install.sh"), "BBB");
    await writeFile(join(dir, "SHA256SUMS"), "old");
    expect(await sha256OfFile(join(dir, "install.sh"))).toBe(sha("BBB"));
    expect(await checksumDir(dir)).toBe(
      `${sha("BBB")}  install.sh\n${sha("AAA")}  mediaforge-linux-x64\n`,
    );
  });
});
