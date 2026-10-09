import type { Tool } from "./version.ts";

export type OsName = "win32" | "linux";
export type CpuArch = "x64" | "arm64";

export interface Target {
  os: OsName;
  arch: CpuArch;
}

export class UnsupportedTargetError extends Error {
  readonly platform: string;
  readonly arch: string;

  constructor(platform: string, arch: string) {
    super(
      `Unsupported platform: ${platform}-${arch}. Supported: win32-x64, linux-x64, linux-arm64.`,
    );
    this.name = "UnsupportedTargetError";
    this.platform = platform;
    this.arch = arch;
  }
}

/** Map Node's platform and arch to a supported target. Windows on ARM runs the x64 build. */
export function resolveTarget(
  platform: string = process.platform,
  arch: string = process.arch,
): Target {
  if (platform === "win32" && (arch === "x64" || arch === "arm64")) {
    return { os: "win32", arch: "x64" };
  }
  if (platform === "linux" && (arch === "x64" || arch === "arm64")) {
    return { os: platform, arch };
  }
  throw new UnsupportedTargetError(platform, arch);
}

export const targetKey = (target: Target): string => `${target.os}-${target.arch}`;

/** The file name a tool has inside the cache. */
export const binaryFileName = (tool: Tool, os: OsName): string =>
  os === "win32" ? `${tool}.exe` : tool;
