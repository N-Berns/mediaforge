import { describe, expect, it } from "vitest";
import { isHashOnlyChange } from "./url.ts";

describe("isHashOnlyChange", () => {
  it("is true when only the fragment differs", () => {
    expect(isHashOnlyChange("https://e.test/app#/a", "https://e.test/app#/b")).toBe(true);
    expect(isHashOnlyChange("https://e.test/app", "https://e.test/app#top")).toBe(true);
    expect(isHashOnlyChange("https://e.test/app#x", "https://e.test/app")).toBe(true);
  });

  it("is false for a real navigation or an unknown previous URL", () => {
    expect(isHashOnlyChange("https://e.test/a#x", "https://e.test/b#x")).toBe(false);
    expect(isHashOnlyChange("https://e.test/a?q=1", "https://e.test/a?q=2")).toBe(false);
    expect(isHashOnlyChange(undefined, "https://e.test/a")).toBe(false);
  });

  it("keeps treating a repeated identical URL as a navigation, as before", () => {
    expect(isHashOnlyChange("https://e.test/a", "https://e.test/a")).toBe(false);
  });

  it("is false for unparsable URLs", () => {
    expect(isHashOnlyChange("not a url#a", "not a url#b")).toBe(false);
  });
});
