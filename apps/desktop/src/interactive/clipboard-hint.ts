import { describeSites } from "./links.ts";

/** Shorten a long link so it fits beside a menu label. */
export function shorten(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/** The dim text shown next to the "use the clipboard" menu entry. */
export function clipboardHint(
  clip: { state: "checking" } | { state: "none" } | { state: "links"; links: string[] },
): string {
  if (clip.state === "checking") return "checking…";
  if (clip.state === "none") return "no link found";
  if (clip.links.length === 1) return shorten(clip.links[0] ?? "", 48);
  return describeSites(clip.links);
}
