import { Text } from "ink";
import { render } from "ink-testing-library";
import { useEffect } from "react";
import { describe, expect, it } from "vitest";
import { type NoticeApi, useNoticeState } from "./notice.tsx";

const tick = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function probe(ms: number) {
  const ref: { api?: NoticeApi } = {};
  function Probe() {
    const api = useNoticeState(ms);
    useEffect(() => {
      ref.api = api;
    });
    return <Text>{api.notice ? `${api.notice.kind}:${api.notice.text}` : "none"}</Text>;
  }
  return { app: render(<Probe />), ref };
}

describe("useNoticeState", () => {
  it("keeps a notice until a screen has shown it, then drops it after the time", async () => {
    const { app, ref } = probe(60);
    await tick(20);
    ref.api?.notify("warn", "Download cancelled");
    await tick(100);
    // Nothing has shown it yet, so the clock has not started.
    expect(app.lastFrame()).toContain("warn:Download cancelled");
    const id = ref.api?.notice?.id ?? -1;
    ref.api?.seen(id);
    await tick(20);
    expect(app.lastFrame()).toContain("warn:Download cancelled");
    await tick(100);
    expect(app.lastFrame()).toContain("none");
    app.unmount();
  });

  it("replaces a notice with a newer one and restarts the clock", async () => {
    const { app, ref } = probe(80);
    await tick(20);
    ref.api?.notify("warn", "first");
    await tick(20);
    ref.api?.seen(ref.api?.notice?.id ?? -1);
    await tick(50);
    ref.api?.notify("ok", "second");
    await tick(20);
    ref.api?.seen(ref.api?.notice?.id ?? -1);
    await tick(50);
    // The first notice's clock would have run out by now; the second one's has not.
    expect(app.lastFrame()).toContain("ok:second");
    app.unmount();
  });

  it("clears at once", async () => {
    const { app, ref } = probe(1000);
    await tick(20);
    ref.api?.notify("error", "boom");
    await tick(20);
    ref.api?.clear();
    await tick(20);
    expect(app.lastFrame()).toContain("none");
    app.unmount();
  });
});
