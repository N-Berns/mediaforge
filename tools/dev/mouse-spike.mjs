// Mouse spike for MediaForge phase 3c: does this terminal send SGR mouse sequences to Node?
// Run: node tools/dev/mouse-spike.mjs   Then click, double-click, scroll the wheel, Shift+click.
// Press q (or Ctrl+C) to stop. Mouse reporting is switched off again on exit.

const ESC = String.fromCharCode(27);
const ON = "\x1b[?1049h\x1b[H\x1b[?1000h\x1b[?1006h";
const OFF = "\x1b[?1000l\x1b[?1006l\x1b[?1049l";
let seen = 0;

const stop = (code = 0) => {
  process.stdout.write(OFF);
  process.stdin.setRawMode?.(false);
  console.log(`Mouse events seen: ${seen}`);
  console.log(seen > 0 ? "RESULT: mouse works here." : "RESULT: no mouse events arrived here.");
  process.exit(code);
};

if (!process.stdin.isTTY) {
  console.log("Run this in a terminal window, not through a pipe.");
  process.exit(1);
}

process.stdout.write(ON);
console.log(
  "Click, double-click, scroll, and Ctrl+click and Alt+click anywhere. Press q to stop.\n",
);
console.log(
  `TERM_PROGRAM=${process.env.TERM_PROGRAM ?? ""} WT_SESSION=${process.env.WT_SESSION ? "set" : "unset"}`,
);
process.stdin.setRawMode(true);
process.stdin.resume();
process.on("uncaughtException", () => stop(1));

process.stdin.on("data", (chunk) => {
  const text = chunk.toString("latin1");
  if (text === "q" || text === "\x03") stop();
  // SGR mouse: ESC [ < button ; column ; row, then M (press) or m (release).
  const events = [...text.matchAll(new RegExp(`${ESC}\\[<(\\d+);(\\d+);(\\d+)([Mm])`, "g"))];
  for (const [, b, x, y, kind] of events) {
    seen += 1;
    const button = Number(b);
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
  if (events.length === 0) console.log(`other input: ${JSON.stringify(text)}`);
});
