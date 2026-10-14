import { describe, expect, it } from "vitest";
import { findMediaIndex, isWorthOverlay, labelFor, placeButton } from "./overlay-logic.ts";

describe("labelFor", () => {
  it("points to the toolbar popup when a quality must be picked", () => {
    expect(labelFor("needs-picker")).toBe("Pick quality in the toolbar popup");
    expect(labelFor("started")).toBe("Started");
    expect(labelFor("nothing")).toBe("Nothing found");
    expect(labelFor("error")).toBe("Failed");
    expect(labelFor(undefined)).toBe("Failed");
  });
});

describe("isWorthOverlay", () => {
  it("accepts a real player and rejects tiny or hidden elements", () => {
    expect(isWorthOverlay({ width: 640, height: 360 }, false)).toBe(true);
    expect(isWorthOverlay({ width: 120, height: 80 }, false)).toBe(false);
    expect(isWorthOverlay({ width: 640, height: 360 }, true)).toBe(false);
  });
});

describe("placeButton", () => {
  it("puts the button in the top-right corner of the element, in page coordinates", () => {
    expect(
      placeButton(
        { top: 100, left: 50, width: 640, height: 360 },
        { x: 0, y: 200 },
        { width: 90, height: 28 },
      ),
    ).toEqual({ top: 308, left: 50 + 640 - 90 - 8 });
  });
});

describe("findMediaIndex", () => {
  it("returns the first video or audio, ignoring other elements", () => {
    expect(findMediaIndex([{ tagName: "DIV" }, { tagName: "AUDIO" }, { tagName: "VIDEO" }])).toBe(
      1,
    );
    expect(findMediaIndex([{ tagName: "video" }])).toBe(0);
    expect(findMediaIndex([{ tagName: "DIV" }, {}, { tagName: "SPAN" }])).toBeUndefined();
    expect(findMediaIndex([])).toBeUndefined();
  });
});
