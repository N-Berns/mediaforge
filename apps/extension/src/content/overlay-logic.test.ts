import { describe, expect, it } from "vitest";
import {
  applyDrag,
  findMediaIndex,
  isDrag,
  isTargetGone,
  isWorthOverlay,
  labelFor,
  placeButton,
} from "./overlay-logic.ts";

describe("labelFor", () => {
  it("points to the toolbar popup when a quality must be picked", () => {
    expect(labelFor("needs-picker")).toBe("Pick quality in the toolbar popup");
    expect(labelFor("needs-picker", undefined, true)).toBe("Choose in the popup");
    expect(labelFor("started")).toBe("Started");
    expect(labelFor("nothing")).toBe("Nothing found");
    expect(labelFor("error")).toBe("Failed");
    expect(labelFor(undefined)).toBe("Failed");
  });

  it("explains why nothing was found", () => {
    expect(labelFor("nothing", "unsupported")).toBe("Not supported here");
    expect(labelFor("nothing", "error")).toBe("Could not check this page");
    expect(labelFor("nothing", "unavailable")).toBe("MediaForge is not running");
    expect(labelFor("nothing", "no-media")).toBe("Nothing found");
    expect(labelFor("nothing", "something-new")).toBe("Nothing found");
    expect(labelFor("nothing", undefined)).toBe("Nothing found");
    expect(labelFor("started", "unsupported")).toBe("Started");
  });
});

describe("isWorthOverlay", () => {
  it("accepts a real player and rejects tiny or hidden elements", () => {
    expect(isWorthOverlay({ width: 640, height: 360 }, false)).toBe(true);
    expect(isWorthOverlay({ width: 120, height: 80 }, false)).toBe(false);
    expect(isWorthOverlay({ width: 640, height: 360 }, true)).toBe(false);
  });
});

describe("isTargetGone", () => {
  const url = "https://example.com/watch?v=1";

  it("keeps the button while the video is in the page and the address is the same", () => {
    expect(isTargetGone({ connected: true, shownUrl: url, currentUrl: url })).toBe(false);
  });

  it("drops the button when the video left the page", () => {
    expect(isTargetGone({ connected: false, shownUrl: url, currentUrl: url })).toBe(true);
  });

  it("drops the button when the page moved to another address in place", () => {
    expect(
      isTargetGone({ connected: true, shownUrl: url, currentUrl: "https://example.com/" }),
    ).toBe(true);
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

describe("placeButton offset", () => {
  it("placeButton adds the offset", () => {
    expect(
      placeButton(
        { top: 100, left: 50, width: 640, height: 360 },
        { x: 0, y: 200 },
        { width: 90, height: 22 },
        { dx: -30, dy: 12 },
      ),
    ).toEqual({ top: 308 + 12, left: 50 + 640 - 90 - 8 - 30 });
  });
});

describe("applyDrag", () => {
  const bounds = { width: 1000, height: 800 };
  const button = { width: 90, height: 22 };

  it("applyDrag moves by the delta", () => {
    expect(applyDrag({ top: 100, left: 200 }, { dx: 15, dy: -20 }, bounds, button)).toEqual({
      top: 80,
      left: 215,
    });
  });

  it("applyDrag keeps the button inside the bounds on every edge", () => {
    expect(applyDrag({ top: 10, left: 10 }, { dx: -50, dy: -50 }, bounds, button)).toEqual({
      top: 0,
      left: 0,
    });
    expect(applyDrag({ top: 700, left: 900 }, { dx: 500, dy: 500 }, bounds, button)).toEqual({
      top: 778,
      left: 910,
    });
  });
});

describe("isDrag", () => {
  it("isDrag is false under 4px and true at or above it", () => {
    expect(isDrag({ dx: 0, dy: 0 })).toBe(false);
    expect(isDrag({ dx: 2, dy: 2 })).toBe(false);
    expect(isDrag({ dx: 3, dy: 0 })).toBe(false);
    expect(isDrag({ dx: 4, dy: 0 })).toBe(true);
    expect(isDrag({ dx: 0, dy: -4 })).toBe(true);
    expect(isDrag({ dx: 3, dy: 3 })).toBe(true);
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
