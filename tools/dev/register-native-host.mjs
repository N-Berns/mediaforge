// Registers MediaForge as a Firefox native messaging host for development, until the installer
// (sub-project 4) does it. Windows only.
//   node tools/dev/register-native-host.mjs            # uses the built CLI through node
//   node tools/dev/register-native-host.mjs --exe C:\path\MediaForge.exe
//   node tools/dev/register-native-host.mjs --brave-id <extension-id>   # also registers Brave
//   node tools/dev/register-native-host.mjs --uninstall
import { execFileSync } from "node:child_process";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HOST_NAME = "com.mediaforge.host";
const ADDON_ID = "mediaforge@n-berns";
export function registryKey(hostName) {
  return `HKCU\\Software\\Mozilla\\NativeMessagingHosts\\${hostName}`;
}

const REG_KEY = registryKey(HOST_NAME);
const BRAVE_REG_KEY = `HKCU\\Software\\BraveSoftware\\Brave-Browser\\NativeMessagingHosts\\${HOST_NAME}`;

// Brave may read Chrome's location instead of its own, so both are written.
const CHROME_REG_KEY = `HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\${HOST_NAME}`;

/** Chromium browsers (Brave, Chrome) allow an extension by its origin, not by add-on id. */
export function buildChromiumHostManifest({ exePath, extensionId, hostName }) {
  return {
    name: hostName,
    description: "MediaForge native messaging host",
    path: exePath,
    type: "stdio",
    allowed_origins: [`chrome-extension://${extensionId}/`],
  };
}

export function buildHostManifest({ exePath, addonId, hostName }) {
  return {
    name: hostName,
    description: "MediaForge native messaging host",
    path: exePath,
    type: "stdio",
    allowed_extensions: [addonId],
  };
}

/** A manifest `path` cannot carry arguments, so development uses a small wrapper script. */
export function buildWrapperCmd({ nodePath, mainJs }) {
  const esc = (value) => value.replaceAll("%", "%%");
  return `@echo off\r\n"${esc(nodePath)}" "${esc(mainJs)}" --native-host %*\r\n`;
}

function main() {
  const args = process.argv.slice(2);
  if (process.platform !== "win32") throw new Error("This dev script supports Windows only.");

  if (args.includes("--uninstall")) {
    for (const key of [REG_KEY, BRAVE_REG_KEY, CHROME_REG_KEY]) {
      try {
        execFileSync("reg.exe", ["delete", key, "/f"], { stdio: "inherit" });
      } catch {
        console.log(`Nothing to remove at ${key}.`);
      }
    }
    return;
  }

  const here = dirname(fileURLToPath(import.meta.url));
  const repo = resolve(here, "..", "..");
  const outDir = join(repo, "apps", "extension", ".dev");
  mkdirSync(outDir, { recursive: true });

  const exeArg = args.indexOf("--exe");
  let hostPath;
  if (exeArg >= 0) {
    hostPath = resolve(args[exeArg + 1]);
  } else {
    hostPath = join(outDir, "mediaforge-host.cmd");
    writeFileSync(
      hostPath,
      buildWrapperCmd({
        nodePath: process.execPath,
        mainJs: join(repo, "apps", "desktop", "dist", "main.js"),
      }),
    );
  }

  const manifestPath = join(outDir, `${HOST_NAME}.json`);
  writeFileSync(
    manifestPath,
    `${JSON.stringify(buildHostManifest({ exePath: hostPath, addonId: ADDON_ID, hostName: HOST_NAME }), null, 2)}\n`,
  );
  execFileSync("reg.exe", ["add", REG_KEY, "/ve", "/t", "REG_SZ", "/d", manifestPath, "/f"], {
    stdio: "inherit",
  });
  console.log(`Registered ${HOST_NAME} -> ${hostPath}`);

  const braveArg = args.indexOf("--brave-id");
  if (braveArg >= 0) {
    const extensionId = args[braveArg + 1];
    if (!/^[a-p]{32}$/.test(extensionId ?? "")) {
      throw new Error("--brave-id needs the 32-letter extension ID from brave://extensions.");
    }
    const braveManifest = join(outDir, `${HOST_NAME}.brave.json`);
    writeFileSync(
      braveManifest,
      `${JSON.stringify(buildChromiumHostManifest({ exePath: hostPath, extensionId, hostName: HOST_NAME }), null, 2)}\n`,
    );
    for (const key of [BRAVE_REG_KEY, CHROME_REG_KEY]) {
      execFileSync("reg.exe", ["add", key, "/ve", "/t", "REG_SZ", "/d", braveManifest, "/f"], {
        stdio: "inherit",
      });
    }
    console.log(`Registered ${HOST_NAME} for Brave extension ${extensionId}`);
  }
}

function isEntryPoint() {
  try {
    if (!process.argv[1]) return false;
    const a = realpathSync(resolve(process.argv[1]));
    const b = realpathSync(fileURLToPath(import.meta.url));
    return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
  } catch {
    return false;
  }
}

if (isEntryPoint()) main();
