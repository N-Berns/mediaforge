import type { InputHub } from "./input.ts";

const ESC = String.fromCharCode(27);

/** Routes an ink-testing-library stdin through the hub, so tests write mouse reports to it. */
export function attachTestStdin(hub: InputHub, stdin: { write: (data: string) => void }): void {
  const original = stdin.write;
  hub.deliver = (text) => original(text);
  stdin.write = (data: string) => hub.feed(data);
}

/** A left-button press at cell (x, y), counted from 0. */
export const pressAt = (x: number, y: number, mods: { ctrl?: boolean } = {}) =>
  `${ESC}[<${mods.ctrl ? 16 : 0};${x + 1};${y + 1}M`;

/** A press and its release. */
export const clickAt = (x: number, y: number, mods: { ctrl?: boolean } = {}) =>
  `${pressAt(x, y, mods)}${ESC}[<${mods.ctrl ? 16 : 0};${x + 1};${y + 1}m`;

/** One wheel notch: -1 up, 1 down. */
export const wheelAt = (x: number, y: number, step: -1 | 1) =>
  `${ESC}[<${step === 1 ? 65 : 64};${x + 1};${y + 1}M`;
