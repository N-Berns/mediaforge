/** One mouse report from the terminal. Cells count from 0, top-left. */
export interface MouseReport {
  kind: "press" | "release" | "wheel";
  /** 0 left, 1 middle, 2 right; for a wheel, -1 up and 1 down. */
  button: number;
  x: number;
  y: number;
  shift: boolean;
  alt: boolean;
  ctrl: boolean;
}

const ESC = String.fromCharCode(27);
/** SGR encoding: ESC [ < code ; column ; row, then M (press) or m (release). */
const SGR = new RegExp(`${ESC}\\[<(\\d+);(\\d+);(\\d+)([Mm])`, "g");
/** The start of a report whose end is still on the way. */
const PARTIAL = new RegExp(`${ESC}\\[<[\\d;]*$`);
const MOTION = 32;
const WHEEL = 64;

/** Extra buttons (back, forward) start here. */
const EXTRA = 128;

/**
 * Motion is never switched on; a terminal that sends it anyway is ignored. So are the
 * horizontal wheel (66, 67) and the extra buttons, which the app has no use for.
 */
function wanted(code: number): boolean {
  if (code & MOTION || code >= EXTRA) return false;
  return !(code & WHEEL && code & 2);
}

function report(code: number, column: number, row: number, final: string): MouseReport {
  const wheel = (code & WHEEL) !== 0;
  return {
    kind: wheel ? "wheel" : final === "M" ? "press" : "release",
    button: wheel ? (code & 1 ? 1 : -1) : code & 3,
    x: column - 1,
    y: row - 1,
    shift: (code & 4) !== 0,
    alt: (code & 8) !== 0,
    ctrl: (code & 16) !== 0,
  };
}

/** Pull the SGR mouse reports out of terminal input. `rest` is a report cut off at the end. */
export function splitInput(chunk: string): { text: string; reports: MouseReport[]; rest: string } {
  const reports: MouseReport[] = [];
  let text = chunk.replace(
    SGR,
    (_match, code: string, column: string, row: string, final: string) => {
      if (wanted(Number(code))) {
        reports.push(report(Number(code), Number(column), Number(row), final));
      }
      return "";
    },
  );
  const rest = PARTIAL.exec(text)?.[0] ?? "";
  if (rest) text = text.slice(0, -rest.length);
  return { text, reports, rest };
}

const NAMED: Record<string, string> = {
  Esc: ESC,
  Enter: "\r",
  Tab: "\t",
  Del: `${ESC}[3~`,
  Space: " ",
};

/**
 * The bytes a hint's key sends, so a click on the hint can type it. Undefined for hints that
 * name more than one key ("↑↓", "1-6"). "N / Esc" types its first key.
 */
export function keySequence(label: string): string | undefined {
  const key = (label.split(" / ")[0] ?? "").trim();
  const named = NAMED[key];
  if (named) return named;
  const ctrl = /^Ctrl\+([A-Z])$/.exec(key)?.[1];
  if (ctrl) return String.fromCharCode(ctrl.charCodeAt(0) - 64);
  return [...key].length === 1 ? key : undefined;
}

/** How long a cut-off report may wait for its end before it counts as typed text. */
const PARTIAL_WAIT_MS = 50;

/**
 * Sits between the terminal and Ink: mouse reports go to the listeners, keys go on to Ink
 * (`deliver`), or to a capture while one is set.
 */
export class InputHub {
  /** Where keys go: Ink's input stream. Set by `terminalStdin` or `attachTestStdin`. */
  deliver: (text: string) => void = () => {};
  private readonly listeners = new Set<(report: MouseReport) => void>();
  private captor: ((text: string) => void) | undefined;
  private held = "";
  private timer: ReturnType<typeof setTimeout> | undefined;

  /** Raw input from the terminal. */
  feed(chunk: string): void {
    clearTimeout(this.timer);
    const { text, reports, rest } = splitInput(this.held + chunk);
    this.held = rest;
    if (rest) {
      this.timer = setTimeout(() => {
        const late = this.held;
        this.held = "";
        this.keys(late);
      }, PARTIAL_WAIT_MS);
    }
    if (text) this.keys(text);
    for (const r of reports) for (const listener of [...this.listeners]) listener(r);
  }

  onMouse(listener: (report: MouseReport) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Keys go to `handler` instead of the screens until the returned function is called. */
  capture(handler: (text: string) => void): () => void {
    this.captor = handler;
    return () => {
      if (this.captor === handler) this.captor = undefined;
    };
  }

  /** Types `text` for the user (a clicked hint). It skips any capture. */
  inject(text: string): void {
    this.deliver(text);
  }

  private keys(text: string): void {
    if (this.captor) this.captor(text);
    else this.deliver(text);
  }
}
