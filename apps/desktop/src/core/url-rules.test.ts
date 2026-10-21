import { describe, expect, it } from "vitest";
import { isPrivateAddress, urlError } from "./url-rules.ts";

const none = async () => [];

describe("isPrivateAddress", () => {
  it.each([
    "127.0.0.1",
    "10.1.2.3",
    "172.16.0.1",
    "172.31.255.255",
    "192.168.1.5",
    "169.254.169.254",
    "100.64.0.1",
    "0.0.0.0",
    "::1",
    "::",
    "fd12:3456::1",
    "fe80::1",
    "::ffff:127.0.0.1",
  ])("%s is private", (address) => expect(isPrivateAddress(address)).toBe(true));

  it.each(["8.8.8.8", "172.32.0.1", "100.128.0.1", "2606:4700::1", "example.com"])(
    "%s is public",
    (address) => expect(isPrivateAddress(address)).toBe(false),
  );
});

describe("urlError", () => {
  it("allows only http and https", async () => {
    expect(await urlError("file:///etc/passwd", true, none)).toMatch(/Only http/);
    expect(await urlError("ftp://example.com/a", true, none)).toMatch(/Only http/);
    expect(await urlError("not a url", true, none)).toMatch(/not a valid/);
    expect(await urlError("https://example.com/v.mp4", false, none)).toBeUndefined();
  });

  it("refuses local and private hosts unless allowed", async () => {
    for (const url of [
      "http://localhost:8080/a",
      "http://printer.local/a",
      "http://127.0.0.1/a",
      "http://[::1]/a",
      "http://192.168.0.10/a",
      "http://2130706433/a",
    ]) {
      expect(await urlError(url, false, none)).toMatch(/allowPrivateUrls/);
      expect(await urlError(url, true, none)).toBeUndefined();
    }
  });

  it("refuses a name that resolves to a private address", async () => {
    const rebinding = async () => ["93.184.216.34", "10.0.0.7"];
    expect(await urlError("https://evil.example/a", false, rebinding)).toMatch(/allowPrivateUrls/);
    expect(await urlError("https://evil.example/a", true, rebinding)).toBeUndefined();
  });

  it("leaves an unresolvable name to the downloader", async () => {
    const fails = async () => {
      throw new Error("ENOTFOUND");
    };
    expect(await urlError("https://nope.example/a", false, fails)).toBeUndefined();
  });
});
