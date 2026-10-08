import { describe, expect, it } from "vitest";
import { execFileText } from "./exec.ts";

describe("execFileText", () => {
  it("resolves with the program's stdout as a string", async () => {
    expect(await execFileText(process.execPath, ["-p", "1 + 1"])).toBe("2\n");
  });

  it("rejects when the program exits with an error", async () => {
    await expect(execFileText(process.execPath, ["-e", "process.exit(3)"])).rejects.toThrow();
  });

  it("rejects when the program does not exist", async () => {
    await expect(execFileText("definitely-not-a-program-mediaforge", [])).rejects.toThrow();
  });

  it("rejects when the program outruns the timeout", async () => {
    await expect(
      execFileText(process.execPath, ["-e", "setTimeout(() => {}, 5000)"], { timeoutMs: 100 }),
    ).rejects.toThrow();
  });
});
