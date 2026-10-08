import { describe, expect, it } from "vitest";
import { checkUrl, describeFailures, findDeadUrls, isAlive, lockUrls } from "./check-lock-urls.mjs";

const reply = (status) => ({ status, body: { cancel: async () => {} } });

/** A fake fetch: `routes` maps "METHOD url" to a status; unknown routes throw a network error. */
const fakeFetch = (routes) => {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, method: init.method, range: init.headers.range });
    const status = routes[`${init.method} ${url}`];
    if (status === undefined) throw new Error("getaddrinfo ENOTFOUND");
    return reply(status);
  };
  fn.calls = calls;
  return fn;
};

describe("lockUrls", () => {
  it("lists the target and url of every ffmpeg entry", () => {
    const lock = {
      ffmpeg: { "linux-x64": { url: "https://a/x" }, "win32-x64": { url: "https://a/y" } },
    };
    expect(lockUrls(lock)).toEqual([
      { target: "linux-x64", url: "https://a/x" },
      { target: "win32-x64", url: "https://a/y" },
    ]);
  });

  it("returns nothing for a lock without ffmpeg entries", () => {
    expect(lockUrls({})).toEqual([]);
  });
});

describe("isAlive", () => {
  it("accepts 2xx and 3xx only", () => {
    expect([200, 206, 302].every(isAlive)).toBe(true);
    expect([199, 400, 404, 500].some(isAlive)).toBe(false);
  });
});

describe("checkUrl", () => {
  it("is ok on a successful HEAD, without a GET", async () => {
    const fetchFn = fakeFetch({ "HEAD https://a/x": 200 });
    expect(await checkUrl("https://a/x", fetchFn)).toMatchObject({ ok: true, status: 200 });
    expect(fetchFn.calls.map((c) => c.method)).toEqual(["HEAD"]);
  });

  it("falls back to a one-byte ranged GET when HEAD is refused", async () => {
    const fetchFn = fakeFetch({ "HEAD https://a/x": 405, "GET https://a/x": 206 });
    expect(await checkUrl("https://a/x", fetchFn)).toMatchObject({ ok: true, status: 206 });
    expect(fetchFn.calls[1]).toMatchObject({ method: "GET", range: "bytes=0-0" });
  });

  it("fails on 404 without trying GET", async () => {
    const fetchFn = fakeFetch({ "HEAD https://a/x": 404 });
    expect(await checkUrl("https://a/x", fetchFn)).toMatchObject({
      ok: false,
      status: 404,
      detail: "HTTP 404",
    });
    expect(fetchFn.calls).toHaveLength(1);
  });

  it("reports a network error as a failure", async () => {
    expect(await checkUrl("https://a/x", fakeFetch({}))).toMatchObject({
      ok: false,
      detail: "getaddrinfo ENOTFOUND",
    });
  });
});

describe("findDeadUrls and describeFailures", () => {
  it("returns only the dead entries and names each one", async () => {
    const entries = [
      { target: "linux-x64", url: "https://a/ok" },
      { target: "win32-x64", url: "https://a/gone" },
    ];
    const failures = await findDeadUrls(
      entries,
      fakeFetch({ "HEAD https://a/ok": 200, "HEAD https://a/gone": 404 }),
    );
    expect(failures.map((f) => f.target)).toEqual(["win32-x64"]);
    const text = describeFailures(failures);
    expect(text).toContain("1 pinned download URL(s)");
    expect(text).toContain("win32-x64: https://a/gone (HTTP 404)");
    expect(text).toContain("pnpm pin:ffmpeg");
  });
});
