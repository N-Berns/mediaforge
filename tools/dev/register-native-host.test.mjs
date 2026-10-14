import { describe, expect, it } from "vitest";
import { buildHostManifest, buildWrapperCmd, registryKey } from "./register-native-host.mjs";

const BS = String.fromCharCode(92);
const win = (...parts) => parts.join(BS);

describe("buildHostManifest", () => {
  it("allows only the MediaForge add-on and points at the executable", () => {
    const exePath = win("C:", "mf", "host.cmd");
    expect(
      buildHostManifest({
        exePath,
        addonId: "mediaforge@n-berns",
        hostName: "com.mediaforge.host",
      }),
    ).toEqual({
      name: "com.mediaforge.host",
      description: "MediaForge native messaging host",
      path: exePath,
      type: "stdio",
      allowed_extensions: ["mediaforge@n-berns"],
    });
  });
});

describe("registryKey", () => {
  it("is the per-user Mozilla native messaging key", () => {
    expect(registryKey("com.mediaforge.host")).toBe(
      win("HKCU", "Software", "Mozilla", "NativeMessagingHosts", "com.mediaforge.host"),
    );
  });
});

describe("buildWrapperCmd", () => {
  it("runs the built CLI in relay mode and forwards the browser's arguments", () => {
    const nodePath = win("C:", "node", "node.exe");
    const mainJs = win("C:", "r", "apps", "desktop", "dist", "main.js");
    const cmd = buildWrapperCmd({ nodePath, mainJs });
    expect(cmd).toContain(`"${nodePath}" "${mainJs}" --native-host %*`);
    expect(cmd.startsWith(`@echo off${String.fromCharCode(13, 10)}`)).toBe(true);
  });

  it("escapes percent signs in paths", () => {
    const cmd = buildWrapperCmd({
      nodePath: win("C:", "a%b", "node.exe"),
      mainJs: win("C:", "100%", "main.js"),
    });
    expect(cmd).toContain(`"${win("C:", "a%%b", "node.exe")}" "${win("C:", "100%%", "main.js")}"`);
  });
});
