// Mouse spike, step 2 (Windows): turn on ENABLE_VIRTUAL_TERMINAL_INPUT for this console, so the
// console hands mouse clicks to Node as SGR text sequences instead of records Node drops.
// Run: node tools/dev/mouse-spike-vt.mjs   Then click, double-click, scroll, Shift+click.
// Press q (or Ctrl+C) to stop. The console mode and mouse reporting are restored on exit.

import { spawnSync } from "node:child_process";

const ESC = String.fromCharCode(27);
const ON = `${ESC}[?1049h${ESC}[H${ESC}[?1000h${ESC}[?1006h`;
const OFF = `${ESC}[?1000l${ESC}[?1006l${ESC}[?1049l`;
const VT_INPUT = 0x0200;

/**
 * Reads, or sets, the console input mode from a PowerShell child that shares this console.
 * Prints the mode it found. `bits` > 0 turns those bits on; < 0 turns them off.
 */
function consoleMode(bits) {
  const script = `
Add-Type -TypeDefinition @"
using System; using System.Runtime.InteropServices;
public static class MfConsole {
  [DllImport("kernel32.dll")] public static extern IntPtr GetStdHandle(int which);
  [DllImport("kernel32.dll", SetLastError = true)] public static extern bool GetConsoleMode(IntPtr h, out uint mode);
  [DllImport("kernel32.dll", SetLastError = true)] public static extern bool SetConsoleMode(IntPtr h, uint mode);
}
"@
# Standard input is inherited from Node: it is this console's input buffer.
$h = [MfConsole]::GetStdHandle(-10)
$m = 0
$ok = [MfConsole]::GetConsoleMode($h, [ref]$m)
if (-not $ok) { "get-failed error={0}" -f [Runtime.InteropServices.Marshal]::GetLastWin32Error(); exit }
$bits = ${bits}
$set = $true
if ($bits -gt 0) { $set = [MfConsole]::SetConsoleMode($h, $m -bor $bits) }
if ($bits -lt 0) { $set = [MfConsole]::SetConsoleMode($h, $m -band (-bnot (-$bits))) }
if (-not $set) { "set-failed error={0}" -f [Runtime.InteropServices.Marshal]::GetLastWin32Error(); exit }
$after = 0
[void][MfConsole]::GetConsoleMode($h, [ref]$after)
"{0:X} {1:X}" -f $m, $after
`;
  const encoded = Buffer.from(script, "utf16le").toString("base64");
  const run = spawnSync(
    "powershell",
    ["-NoProfile", "-NonInteractive", "-EncodedCommand", encoded],
    {
      stdio: ["inherit", "pipe", "pipe"],
      encoding: "utf8",
    },
  );
  return (run.stdout || run.stderr || "").trim();
}

let seen = 0;
let other = 0;
const mods = { Shift: 0, Alt: 0, Ctrl: 0 };

const stop = (code = 0) => {
  process.stdout.write(OFF);
  const restored = consoleMode(-VT_INPUT);
  process.stdin.setRawMode?.(false);
  console.log(`Terminal: ${terminal}`);
  console.log(`Console input mode at start (before after): ${changed}`);
  console.log(`Console mode restored (before after): ${restored}`);
  console.log(`Mouse events seen: ${seen}, other input chunks: ${other}`);
  console.log(`With modifiers: Shift ${mods.Shift}, Alt ${mods.Alt}, Ctrl ${mods.Ctrl}`);
  console.log(seen > 0 ? "RESULT: mouse works here." : "RESULT: no mouse events arrived here.");
  process.exit(code);
};

if (process.platform !== "win32") {
  console.log("This step is for Windows only; use tools/dev/mouse-spike.mjs elsewhere.");
  process.exit(1);
}
if (!process.stdin.isTTY) {
  console.log("Run this in a terminal window, not through a pipe.");
  process.exit(1);
}

const terminal = `TERM_PROGRAM=${process.env.TERM_PROGRAM ?? ""} WT_SESSION=${process.env.WT_SESSION ? "set" : "unset"}`;
process.stdin.setRawMode(true);
const changed = consoleMode(VT_INPUT);
process.stdout.write(ON);
console.log(
  `TERM_PROGRAM=${process.env.TERM_PROGRAM ?? ""} WT_SESSION=${process.env.WT_SESSION ? "set" : "unset"}`,
);
console.log(`Console input mode (before after): ${changed}`);
console.log(
  "Click, double-click, scroll, and Ctrl+click and Alt+click anywhere. Press q to stop.\n",
);
process.stdin.resume();
process.on("uncaughtException", () => stop(1));

process.stdin.on("data", (chunk) => {
  const text = chunk.toString("latin1");
  if (text === "q" || text === "\x03") stop();
  const events = [...text.matchAll(new RegExp(`${ESC}\\[<(\\d+);(\\d+);(\\d+)([Mm])`, "g"))];
  for (const [, b, x, y, kind] of events) {
    seen += 1;
    const button = Number(b);
    if (button & 4) mods.Shift += 1;
    if (button & 8) mods.Alt += 1;
    if (button & 16) mods.Ctrl += 1;
    const what =
      (button & 64) !== 0
        ? button & 1
          ? "wheel down"
          : "wheel up"
        : kind === "M"
          ? "press"
          : "release";
    const shift = [
      button & 4 ? " +Shift" : "",
      button & 8 ? " +Alt" : "",
      button & 16 ? " +Ctrl" : "",
    ].join("");
    console.log(`mouse: ${what}${shift} at column ${x}, row ${y}  (raw button ${b})`);
  }
  if (events.length === 0) {
    other += 1;
    console.log(`other input: ${JSON.stringify(text)}`);
  }
});
