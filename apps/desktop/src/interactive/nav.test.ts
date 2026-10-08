import { describe, expect, it } from "vitest";
import { canPop, createStack, popEntry, pushEntry, resetStack, topOf, unwind } from "./nav.ts";

describe("nav stack", () => {
  it("starts with the root and pushes new entries on top", () => {
    const s = pushEntry(pushEntry(createStack("home"), "link"), "quality");
    expect(topOf(s)).toBe("quality");
    expect(s.entries).toEqual(["home", "link", "quality"]);
    expect(canPop(s)).toBe(true);
  });

  it("pops one entry at a time, like a browser back button", () => {
    let s = pushEntry(pushEntry(createStack("home"), "link"), "quality");
    s = popEntry(s);
    expect(topOf(s)).toBe("link");
    s = popEntry(s);
    expect(topOf(s)).toBe("home");
  });

  it("never pops the root", () => {
    const s = popEntry(popEntry(createStack("home")));
    expect(s.entries).toEqual(["home"]);
    expect(canPop(s)).toBe(false);
  });

  it("replaces the top entry without growing the history", () => {
    const s = unwind(pushEntry(createStack("home"), "lookup"), 1, "quality");
    expect(s.entries).toEqual(["home", "quality"]);
  });

  it("unwinds several entries and pushes one", () => {
    const stack = ["a", "b", "c", "d"].reduce((acc, e) => pushEntry(acc, e), createStack("root"));
    expect(unwind(stack, 3, "x").entries).toEqual(["root", "a", "x"]);
  });

  it("unwinding more than the stack holds leaves just the new entry", () => {
    expect(unwind(createStack("home"), 5, "x").entries).toEqual(["x"]);
  });

  it("resets to the given entries, last one on top", () => {
    const s = resetStack("home", "link");
    expect(s.entries).toEqual(["home", "link"]);
    expect(topOf(s)).toBe("link");
  });
});
