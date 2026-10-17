import { afterEach, describe, expect, it, vi } from "vitest";
import { InputHub, keySequence, splitInput } from "./input.ts";
import { clickAt, moveAt, pressAt, wheelAt } from "./testing.ts";

const ESC = "\u001b";

describe("splitInput", () => {
  it("leaves plain keys alone", () => {
    expect(splitInput("abc")).toEqual({ text: "abc", reports: [], rest: "" });
  });

  it("takes out a press and a release, keeping the keys around them", () => {
    const out = splitInput(`a${ESC}[<0;10;5Mb${ESC}[<0;10;5m`);
    expect(out.text).toBe("ab");
    expect(out.rest).toBe("");
    expect(out.reports).toEqual([
      { kind: "press", button: 0, x: 9, y: 4, shift: false, alt: false, ctrl: false },
      { kind: "release", button: 0, x: 9, y: 4, shift: false, alt: false, ctrl: false },
    ]);
  });

  it("reads the wheel and the modifiers", () => {
    const { reports } = splitInput(`${ESC}[<64;1;1M${ESC}[<65;1;1M${ESC}[<16;3;2M${ESC}[<8;3;2M`);
    expect(reports.map((r) => [r.kind, r.button, r.ctrl, r.alt])).toEqual([
      ["wheel", -1, false, false],
      ["wheel", 1, false, false],
      ["press", 0, true, false],
      ["press", 0, false, true],
    ]);
  });

  it("reads motion as a move report", () => {
    expect(splitInput(`${ESC}[<35;4;4M`)).toEqual({
      text: "",
      reports: [{ kind: "move", button: 3, x: 3, y: 3, shift: false, alt: false, ctrl: false }],
      rest: "",
    });
  });

  it("drops horizontal wheel reports", () => {
    expect(splitInput(`${ESC}[<66;4;4M${ESC}[<67;4;4M`)).toEqual({
      text: "",
      reports: [],
      rest: "",
    });
  });

  it("drops extra buttons (back, forward)", () => {
    expect(splitInput(`${ESC}[<128;4;4M${ESC}[<129;4;4M${ESC}[<128;4;4m`)).toEqual({
      text: "",
      reports: [],
      rest: "",
    });
  });

  it("keeps a report cut off at the end as rest", () => {
    expect(splitInput(`x${ESC}[<0;1`)).toEqual({ text: "x", reports: [], rest: `${ESC}[<0;1` });
  });

  it("passes a lone Esc straight through", () => {
    expect(splitInput(ESC)).toEqual({ text: ESC, reports: [], rest: "" });
    expect(splitInput(`${ESC}[A`)).toEqual({ text: `${ESC}[A`, reports: [], rest: "" });
  });
});

describe("keySequence", () => {
  it("maps hint keys to the bytes the key sends", () => {
    expect(keySequence("Esc")).toBe(ESC);
    expect(keySequence("Enter")).toBe("\r");
    expect(keySequence("Tab")).toBe("\t");
    expect(keySequence("Del")).toBe(`${ESC}[3~`);
    expect(keySequence("Ctrl+N")).toBe("\u000e");
    expect(keySequence("Ctrl+C")).toBe("\u0003");
    expect(keySequence("p")).toBe("p");
    expect(keySequence("?")).toBe("?");
    expect(keySequence("N / Esc")).toBe("N");
  });

  it("has no bytes for hints that name several keys", () => {
    expect(keySequence("↑↓")).toBeUndefined();
    expect(keySequence("1-6")).toBeUndefined();
  });
});

describe("InputHub", () => {
  afterEach(() => vi.useRealTimers());

  const hub = () => {
    const h = new InputHub();
    const keys: string[] = [];
    const reports: unknown[] = [];
    h.deliver = (text) => keys.push(text);
    h.onMouse((r) => reports.push(r));
    return { h, keys, reports };
  };

  it("sends keys on and reports to the listeners", () => {
    const { h, keys, reports } = hub();
    h.feed(`q${clickAt(2, 3)}`);
    expect(keys).toEqual(["q"]);
    expect(reports).toHaveLength(2);
  });

  it("holds a cut-off report until the rest arrives", () => {
    const { h, keys, reports } = hub();
    const press = pressAt(2, 3);
    h.feed(press.slice(0, 5));
    h.feed(press.slice(5));
    expect(keys).toEqual([]);
    expect(reports).toHaveLength(1);
  });

  it("lets a held prefix go as keys when nothing follows", () => {
    vi.useFakeTimers();
    const { h, keys } = hub();
    h.feed(`${ESC}[<1`);
    expect(keys).toEqual([]);
    vi.advanceTimersByTime(60);
    expect(keys).toEqual([`${ESC}[<1`]);
  });

  it("routes keys to a capture until it is released; injected keys skip it", () => {
    const { h, keys } = hub();
    const caught: string[] = [];
    const release = h.capture((text) => caught.push(text));
    h.feed("n");
    h.inject("\u0003");
    release();
    h.feed("z");
    expect(caught).toEqual(["n"]);
    expect(keys).toEqual(["\u0003", "z"]);
  });

  it("builds wheel reports for tests", () => {
    expect(splitInput(wheelAt(0, 0, 1)).reports[0]?.kind).toBe("wheel");
  });

  it("builds move reports for tests", () => {
    expect(splitInput(moveAt(5, 6)).reports[0]).toMatchObject({ kind: "move", x: 5, y: 6 });
  });
});
