import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { TARGETS } from "./targets.mjs";

const workflow = await readFile(
  new URL("../../.github/workflows/release.yml", import.meta.url),
  "utf8",
);

describe("release.yml", () => {
  it("smoke-tests every target on the runner targets.mjs names", () => {
    const rows = [
      ...workflow.matchAll(/target: ([\w-]+), runner: ([\w.-]+), file: ([\w.-]+)/g),
    ].map((m) => ({ key: m[1], runner: m[2], file: m[3] }));
    expect(rows).toEqual(TARGETS);
  });

  it("only runs for version tags", () => {
    expect(workflow).toMatch(/tags:\s*\n\s*- "v\*"/);
  });

  it("stamps both installers with the tag", () => {
    expect(workflow).toContain("install/install.sh");
    expect(workflow).toContain("install/install.ps1");
    expect(workflow).toContain("__RELEASE_TAG__");
  });

  it("installs every tool and requires doctor to pass in both install jobs", () => {
    const unix = workflow.indexOf("\n  verify-install:");
    const windows = workflow.indexOf("\n  verify-install-windows:");
    expect(unix).toBeGreaterThan(-1);
    expect(windows).toBeGreaterThan(unix);
    const bodies = {
      "verify-install": workflow.slice(unix, windows),
      "verify-install-windows": workflow.slice(windows),
    };
    for (const [job, body] of Object.entries(bodies)) {
      expect(body, job).toContain("setup --yes");
      expect(body, job).not.toContain("setup --yes --tools");
      expect(body, job).toContain("doctor --json");
    }
  });

  it("skips both install jobs on a private repository", () => {
    const unix = workflow.indexOf("\n  verify-install:");
    const windows = workflow.indexOf("\n  verify-install-windows:");
    for (const body of [workflow.slice(unix, windows), workflow.slice(windows)]) {
      expect(body).toContain(`if: \${{ !github.event.repository.private }}`);
    }
  });

  it("checks the tag format and that the pinned URLs resolve before building", () => {
    expect(workflow).toContain("A-Za-z.");
    expect(workflow).toContain("node tools/release/check-lock-urls.mjs");
  });
});
