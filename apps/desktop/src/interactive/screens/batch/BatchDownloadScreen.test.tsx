import { describe, expect, it } from "vitest";
import type { EngineJob } from "../../../engine/index.ts";
import { COLORS, ICONS } from "../../theme.ts";
import { rowLook } from "./BatchDownloadScreen.tsx";

const job = (status: EngineJob["status"]) => ({ status }) as EngineJob;

describe("rowLook", () => {
  it("gives a paused row its own icon and color, apart from a cancelled one", () => {
    expect(rowLook(job("paused"))).toEqual({ icon: ICONS.paused, color: COLORS.paused });
    expect(rowLook(job("cancelled"))).toEqual({ icon: ICONS.warn, color: COLORS.warn });
    expect(ICONS.paused).not.toBe(ICONS.warn);
    expect(COLORS.paused).not.toBe(COLORS.warn);
  });
});
