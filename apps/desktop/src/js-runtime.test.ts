import { delimiter, join } from "node:path";
import { describe, expect, it } from "vitest";
import { detectJsRuntime, jsRuntimeArgs } from "./js-runtime.ts";

const BIN = join("/", "opt", "bin");

function detect(outputs: Record<string, string | Error>) {
  const ran: string[] = [];
  return {
    ran,
    run: () =>
      detectJsRuntime({
        env: { PATH: BIN },
        platform: "linux",
        isExecutable: async (path) => path.startsWith(BIN) && path.slice(BIN.length + 1) in outputs,
        run: async (path) => {
          ran.push(path);
          const output = outputs[path.slice(BIN.length + 1)];
          if (output instanceof Error) throw output;
          return output as string;
        },
      }),
  };
}

describe("detectJsRuntime", () => {
  it("prefers Deno", async () => {
    const t = detect({ deno: "deno 2.1.4 (stable)\nv8 13.0", node: "v22.1.0" });
    expect(await t.run()).toEqual({
      name: "deno",
      path: join(BIN, "deno"),
      version: "deno 2.1.4 (stable)",
    });
  });

  it("uses Node 20 or newer when there is no Deno", async () => {
    const found = await detect({ node: "v22.1.0" }).run();
    expect(found).toMatchObject({ name: "node", version: "v22.1.0" });
  });

  it("skips Node older than 20", async () => {
    expect(await detect({ node: "v18.19.0" }).run()).toBeUndefined();
  });

  it("accepts QuickJS without running it, then Bun", async () => {
    const quick = detect({ qjs: "unused" });
    expect(await quick.run()).toEqual({ name: "quickjs", path: join(BIN, "qjs") });
    expect(quick.ran).toEqual([]);
    expect(await detect({ bun: "1.1.0" }).run()).toMatchObject({ name: "bun" });
  });

  it("skips a runtime whose version command fails", async () => {
    const found = await detect({ deno: new Error("boom"), node: "v22.0.0" }).run();
    expect(found?.name).toBe("node");
  });

  it("returns undefined when there is none", async () => {
    expect(await detect({}).run()).toBeUndefined();
  });

  it("searches every PATH entry", async () => {
    const found = await detectJsRuntime({
      env: { PATH: ["/a", "/b"].join(delimiter) },
      platform: "linux",
      isExecutable: async (path) => path === join("/b", "deno"),
      run: async () => "deno 2.0.0",
    });
    expect(found?.path).toBe(join("/b", "deno"));
  });
});

describe("jsRuntimeArgs", () => {
  it("needs no flag for Deno or when nothing was found", () => {
    expect(jsRuntimeArgs(undefined)).toEqual([]);
    expect(jsRuntimeArgs({ name: "deno", path: "/bin/deno" })).toEqual([]);
  });

  it("enables the other runtimes by name and path", () => {
    expect(jsRuntimeArgs({ name: "node", path: "/usr/bin/node" })).toEqual([
      "--js-runtimes",
      "node:/usr/bin/node",
    ]);
    expect(jsRuntimeArgs({ name: "quickjs", path: "/usr/bin/qjs" })).toEqual([
      "--js-runtimes",
      "quickjs:/usr/bin/qjs",
    ]);
  });
});
