import type { DownloadJob, DownloadStatus } from "@mediaforge/shared-types";
import { describe, expect, it } from "vitest";
import {
  type Action,
  appliesTo,
  confirmText,
  resultText,
  split,
  targets,
  tooLargeText,
} from "./actions.ts";

const job = (id: string, status: DownloadStatus = "completed"): DownloadJob => ({
  id,
  request: {
    candidate: {
      id: "u",
      pageUrl: "u",
      url: "u",
      kind: "video",
      streamType: "progressive",
      source: "dom",
      variants: [],
      detectedAt: 0,
    },
    profileId: "best",
  },
  status,
  progress: { bytesDownloaded: 0 },
  createdAt: 0,
  updatedAt: 0,
});

const STATUSES: DownloadStatus[] = [
  "queued",
  "downloading",
  "processing",
  "paused",
  "completed",
  "failed",
  "cancelled",
];

describe("appliesTo", () => {
  const table: Record<Action, DownloadStatus[]> = {
    pause: ["queued", "downloading", "processing"],
    resume: ["paused", "failed"],
    cancel: ["queued", "downloading", "processing", "paused"],
    remove: STATUSES,
    trash: STATUSES,
    limit: ["queued", "downloading", "processing", "paused", "failed"],
    open: ["completed"],
  };
  for (const [action, allowed] of Object.entries(table) as [Action, DownloadStatus[]][]) {
    it(`${action} applies to ${allowed.join(", ")}`, () => {
      for (const status of STATUSES) {
        expect(appliesTo(action, job("a", status))).toBe(allowed.includes(status));
      }
    });
  }
});

describe("targets", () => {
  const visible = [job("a"), job("b"), job("c")];

  it("prefers ticked visible rows", () => {
    expect(targets(visible, new Set(["c", "a"]), "b").map((j) => j.id)).toEqual(["a", "c"]);
  });

  it("ignores ticks on hidden rows and falls back to the cursor row", () => {
    expect(targets(visible, new Set(["hidden"]), "b").map((j) => j.id)).toEqual(["b"]);
  });

  it("is empty with no cursor and no ticks", () => {
    expect(targets(visible, new Set(), undefined)).toEqual([]);
  });
});

describe("split", () => {
  it("counts the rows an action skips", () => {
    expect(split("pause", [job("a", "downloading"), job("b"), job("c", "queued")])).toEqual({
      ids: ["a", "c"],
      skipped: 1,
    });
  });
});

describe("texts", () => {
  it("cancel", () => {
    expect(confirmText("cancel", [job("a"), job("b"), job("c")])).toBe(
      "Cancel 3 downloads? Partial files are deleted. y/N",
    );
    expect(confirmText("cancel", [job("a")])).toBe(
      "Cancel 1 download? Partial files are deleted. y/N",
    );
  });

  it("remove asks only when a row is still running", () => {
    expect(confirmText("remove", [job("a"), job("b")])).toBeUndefined();
    expect(confirmText("remove", [job("a", "downloading"), job("b"), job("c")])).toBe(
      "Remove 3 downloads? 1 is still running and will be cancelled. y/N",
    );
    expect(confirmText("remove", [job("a", "queued"), job("b", "processing")])).toBe(
      "Remove 2 downloads? 2 are still running and will be cancelled. y/N",
    );
  });

  it("trash and clear", () => {
    expect(confirmText("trash", [job("a"), job("b"), job("c")])).toBe(
      "Move the files of 3 downloads to the trash? y/N",
    );
    expect(confirmText("clear", [job("a"), job("b"), job("c"), job("d"), job("e")])).toBe(
      "Clear 5 finished downloads from the list? Files stay on disk. y/N",
    );
    expect(confirmText("clear", [job("a")])).toBe(
      "Clear 1 finished download from the list? Files stay on disk. y/N",
    );
  });

  it("too-large", () => {
    expect(tooLargeText(2)).toBe(
      "2 downloads are too large for the Recycle Bin and will be deleted permanently. Delete? y/N",
    );
    expect(tooLargeText(1)).toBe(
      "1 download is too large for the Recycle Bin and will be deleted permanently. Delete? y/N",
    );
  });

  it("result", () => {
    expect(resultText("pause", 2, 0, [])).toBe("Paused 2");
    expect(resultText("pause", 2, 1, [])).toBe("Paused 2 · 1 skipped");
    expect(resultText("pause", 1, 0, [{ message: "No such download." }])).toBe(
      "Paused 1 · 1 failed: No such download.",
    );
    expect(resultText("pause", 0, 2, [])).toBe("Nothing to pause.");
    expect(resultText("trash", 3, 0, [])).toBe("Moved to the trash 3");
    expect(resultText("open", 0, 1, [])).toBe("Nothing to open.");
  });
});
