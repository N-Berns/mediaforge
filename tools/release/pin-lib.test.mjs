import { describe, expect, it } from "vitest";
import { BTBN_TARGETS, renderLock, selectBtbnAsset, selectMonthEndRelease } from "./pin-lib.mjs";

// Real asset names from BtbN/FFmpeg-Builds (release autobuild-2026-10-07-13-07), plus the floating
// "latest" aliases that live in the moving `latest` release and must never be pinned.
const names = [
  "checksums.sha256",
  "ffmpeg-master-latest-win64-lgpl.zip",
  "ffmpeg-n9.0-latest-win64-lgpl-9.0.zip",
  "ffmpeg-n9.0-latest-linux64-lgpl-9.0.tar.xz",
  "ffmpeg-N-127233-g452820cba6-win64-lgpl.zip",
  "ffmpeg-n8.1.3-14-g330caae0c1-win64-lgpl-8.1.zip",
  "ffmpeg-n8.1.3-14-g330caae0c1-linux64-lgpl-8.1.tar.xz",
  "ffmpeg-n8.1.3-14-g330caae0c1-linuxarm64-lgpl-8.1.tar.xz",
  "ffmpeg-n9.0.2-22-g46d8f462ee-win64-lgpl-9.0.zip",
  "ffmpeg-n9.0.2-22-g46d8f462ee-win64-lgpl-shared-9.0.zip",
  "ffmpeg-n9.0.2-22-g46d8f462ee-winarm64-lgpl-9.0.zip",
  "ffmpeg-n9.0.2-22-g46d8f462ee-linux64-lgpl-9.0.tar.xz",
  "ffmpeg-n9.0.2-22-g46d8f462ee-linux64-lgpl-shared-9.0.tar.xz",
  "ffmpeg-n9.0.2-22-g46d8f462ee-linuxarm64-lgpl-9.0.tar.xz",
  "ffmpeg-n9.0.2-22-g46d8f462ee-linuxarm64-lgpl-shared-9.0.tar.xz",
  "ffmpeg-n9.0.2-22-g46d8f462ee-win64-gpl-9.0.zip",
];

describe("selectBtbnAsset", () => {
  it("picks the versioned static LGPL build for each target", () => {
    expect(selectBtbnAsset(names, "win32-x64")).toEqual({
      name: "ffmpeg-n9.0.2-22-g46d8f462ee-win64-lgpl-9.0.zip",
      version: "9.0.2",
    });
    expect(selectBtbnAsset(names, "linux-x64").name).toBe(
      "ffmpeg-n9.0.2-22-g46d8f462ee-linux64-lgpl-9.0.tar.xz",
    );
    expect(selectBtbnAsset(names, "linux-arm64").name).toBe(
      "ffmpeg-n9.0.2-22-g46d8f462ee-linuxarm64-lgpl-9.0.tar.xz",
    );
  });

  it("never picks a floating latest alias", () => {
    const aliases = [
      "ffmpeg-n9.0-latest-win64-lgpl-9.0.zip",
      "ffmpeg-n9.0-latest-linux64-lgpl-9.0.tar.xz",
    ];
    expect(() => selectBtbnAsset(aliases, "win32-x64")).toThrow(/win64/);
    expect(() => selectBtbnAsset(aliases, "linux-x64")).toThrow(/linux64/);
  });

  it("prefers the highest version when a release has several", () => {
    const more = [...names, "ffmpeg-n10.0-3-gabcdef0-win64-lgpl-10.0.zip"];
    expect(selectBtbnAsset(more, "win32-x64").version).toBe("10.0");
  });

  it("fails with the candidate names when nothing matches", () => {
    expect(() => selectBtbnAsset(["ffmpeg-master-latest-win64-lgpl.zip"], "win32-x64")).toThrow(
      /win64/,
    );
  });

  it("describes how to unpack each target", () => {
    expect(BTBN_TARGETS["win32-x64"]).toMatchObject({ archive: "zip", member: "bin/ffmpeg.exe" });
    expect(BTBN_TARGETS["linux-x64"]).toMatchObject({ archive: "tar.xz", member: "bin/ffmpeg" });
  });
});

describe("renderLock", () => {
  it("sorts keys and ends with a newline", () => {
    const text = renderLock({
      schema: 1,
      ffmpeg: { "linux-x64": { b: 1, a: 2 }, "aaa-first": {} },
    });
    expect(text.endsWith("\n")).toBe(true);
    expect(text.indexOf("aaa-first")).toBeLessThan(text.indexOf("linux-x64"));
    expect(text.indexOf('"a"')).toBeLessThan(text.indexOf('"b"'));
  });
});

describe("selectMonthEndRelease", () => {
  const release = (tag) => ({ tag_name: tag, assets: [{ name: tag }] });
  const always = () => true;
  const now = new Date("2026-10-08T12:00:00Z");

  it("picks the newest finished month's last build, never a daily build", () => {
    const releases = [
      "autobuild-2026-10-07-13-07",
      "autobuild-2026-10-06-13-07",
      "autobuild-2026-09-30-13-12",
      "autobuild-2026-09-29-13-11",
      "autobuild-2026-08-31-13-10",
    ].map(release);
    expect(selectMonthEndRelease(releases, always, now).tag_name).toBe(
      "autobuild-2026-09-30-13-12",
    );
  });

  it("ignores the current month even when it is the only month listed", () => {
    const releases = ["autobuild-2026-10-07-13-07", "autobuild-2026-10-06-13-07"].map(release);
    expect(() => selectMonthEndRelease(releases, always, now)).toThrow(/month-end/);
  });

  it("uses the last build of a month by time, whatever the list order", () => {
    const releases = [
      "autobuild-2026-09-02-13-00",
      "autobuild-2026-09-30-23-59",
      "autobuild-2026-09-30-01-00",
    ].map(release);
    expect(selectMonthEndRelease(releases, always, now).tag_name).toBe(
      "autobuild-2026-09-30-23-59",
    );
  });

  it("falls back to an older month when the newest month-end lacks a build", () => {
    const releases = ["autobuild-2026-09-30-13-12", "autobuild-2026-08-31-13-10"].map(release);
    const found = selectMonthEndRelease(releases, (r) => r.tag_name.includes("08-31"), now);
    expect(found.tag_name).toBe("autobuild-2026-08-31-13-10");
  });

  it("skips releases that are not dated autobuilds", () => {
    const releases = ["latest", "autobuild-2026-09-30-13-12"].map(release);
    expect(selectMonthEndRelease(releases, always, now).tag_name).toBe(
      "autobuild-2026-09-30-13-12",
    );
  });
});
