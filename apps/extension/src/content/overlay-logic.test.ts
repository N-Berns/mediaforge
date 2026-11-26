import { describe, expect, it } from "vitest";
import {
  applyDrag,
  findMediaIndex,
  frameBounds,
  hidePlan,
  isDrag,
  isTargetGone,
  isWorthOverlay,
  labelFor,
  placeAtSpot,
  placeButton,
  spotIn,
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

describe("frameBounds", () => {
  it("is the element's box in page coordinates, inset on every side", () => {
    expect(frameBounds({ top: 100, left: 50, width: 640, height: 360 }, { x: 10, y: 200 })).toEqual(
      { top: 308, left: 68, width: 624, height: 344 },
    );
  });
});

describe("applyDrag", () => {
  const bounds = { top: 0, left: 0, width: 1000, height: 800 };
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

  it("applyDrag keeps the button inside a video's frame", () => {
    const frame = frameBounds({ top: 100, left: 50, width: 640, height: 360 }, { x: 0, y: 0 });
    expect(applyDrag({ top: 120, left: 300 }, { dx: -900, dy: -900 }, frame, button)).toEqual({
      top: 108,
      left: 58,
    });
    expect(applyDrag({ top: 120, left: 300 }, { dx: 900, dy: 900 }, frame, button)).toEqual({
      top: 100 + 360 - 8 - 22,
      left: 50 + 640 - 8 - 90,
    });
  });

  it("applyDrag pins the button to the frame's top-left when the frame is too small for it", () => {
    const frame = { top: 50, left: 40, width: 60, height: 10 };
    expect(applyDrag({ top: 0, left: 0 }, { dx: 500, dy: 500 }, frame, button)).toEqual({
      top: 50,
      left: 40,
    });
  });
});

describe("spotIn / placeAtSpot", () => {
  const button = { width: 90, height: 22 };
  const theater = { top: 8, left: 8, width: 1264, height: 704 };
  const normal = { top: 108, left: 58, width: 624, height: 344 };

  it("spotIn is the position as a share of the room the button can move in", () => {
    // Room: 1264 - 90 = 1174 across, 704 - 22 = 682 down.
    expect(spotIn({ top: 8, left: 8 + 352.2 }, theater, button)).toEqual({ x: 0.3, y: 0 });
    expect(spotIn({ top: 8 + 682, left: 8 + 1174 }, theater, button)).toEqual({ x: 1, y: 1 });
  });

  it("spotIn clamps to 0..1 and is 0 when there is no room", () => {
    expect(spotIn({ top: -50, left: 5000 }, theater, button)).toEqual({ x: 1, y: 0 });
    expect(
      spotIn({ top: 60, left: 60 }, { top: 50, left: 40, width: 60, height: 10 }, button),
    ).toEqual({ x: 0, y: 0 });
  });

  it("placeAtSpot keeps the same share when the frame changes size", () => {
    const spot = spotIn({ top: 8, left: 8 + 352.2 }, theater, button);
    // Room in the smaller frame: 624 - 90 = 534 across.
    const pos = placeAtSpot(spot, normal, button);
    expect(pos.top).toBe(108);
    expect(pos.left).toBeCloseTo(58 + 0.3 * 534);
  });

  it("placeAtSpot puts the top-right spot on the default corner", () => {
    const rect = { top: 100, left: 50, width: 640, height: 360 };
    const scroll = { x: 0, y: 0 };
    expect(placeAtSpot({ x: 1, y: 0 }, frameBounds(rect, scroll), button)).toEqual(
      placeButton(rect, scroll, button),
    );
  });
});

describe("hidePlan", () => {
  const base = { held: false, inside: false, moved: false, shown: true, pending: undefined };

  it("keeps a held pill up and drops any hide timer", () => {
    for (const pending of [undefined, "idle", "leave"] as const) {
      expect(hidePlan({ ...base, held: true, pending })).toEqual({ reveal: true, timer: "clear" });
    }
  });

  it("shows the pill on a move over the video and restarts the idle timer", () => {
    expect(hidePlan({ ...base, inside: true, moved: true, shown: false })).toEqual({
      reveal: true,
      timer: "idle",
    });
    expect(hidePlan({ ...base, inside: true, moved: true, pending: "idle" })).toEqual({
      reveal: true,
      timer: "idle",
    });
  });

  it("does not bring an idle-hidden pill back without a move", () => {
    expect(hidePlan({ ...base, inside: true, shown: false })).toEqual({
      reveal: false,
      timer: "keep",
    });
  });

  it("starts the idle timer for a shown pill over the video that has none", () => {
    expect(hidePlan({ ...base, inside: true })).toEqual({ reveal: false, timer: "idle" });
    expect(hidePlan({ ...base, inside: true, pending: "leave" })).toEqual({
      reveal: false,
      timer: "idle",
    });
    expect(hidePlan({ ...base, inside: true, pending: "idle" })).toEqual({
      reveal: false,
      timer: "keep",
    });
  });

  it("starts the leave timer once when the pointer is off the video", () => {
    expect(hidePlan({ ...base, moved: true })).toEqual({ reveal: false, timer: "leave" });
    expect(hidePlan({ ...base, moved: true, pending: "idle" })).toEqual({
      reveal: false,
      timer: "leave",
    });
    // Moving about outside must not push the hide back.
    expect(hidePlan({ ...base, moved: true, pending: "leave" })).toEqual({
      reveal: false,
      timer: "keep",
    });
    expect(hidePlan({ ...base, moved: true, shown: false })).toEqual({
      reveal: false,
      timer: "keep",
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
