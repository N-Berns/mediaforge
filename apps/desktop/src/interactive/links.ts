import { parseHttpUrl } from "../parse.ts";

export interface ParsedLinks {
  /** Valid http(s) links, in the order given, without repeats. */
  links: string[];
  /** Pieces of text that are not links. */
  rejected: string[];
}

/** Punctuation that often clings to a link copied from a sentence or a list. */
const TRAILING = /[.,;:!?)\]>"']+$/;
const LEADING = /^[(<["']+/;

/**
 * Split text into links. Links can be separated by spaces, tabs, new lines or commas, so a list
 * copied from anywhere works. One link gives a one-item list.
 */
export function parseLinks(text: string): ParsedLinks {
  const links: string[] = [];
  const rejected: string[] = [];
  for (const raw of text.split(/[\s,]+/)) {
    const token = raw.replace(LEADING, "").replace(TRAILING, "");
    if (!token) continue;
    try {
      const url = parseHttpUrl(token);
      if (!links.includes(url)) links.push(url);
    } catch {
      rejected.push(raw);
    }
  }
  return { links, rejected };
}

/** Every http(s) link found anywhere in some text (for the clipboard, which may hold prose). */
export function findLinks(text: string | undefined): string[] {
  const found = (text ?? "").match(/https?:\/\/[^\s<>"']+/gi) ?? [];
  return parseLinks(found.join(" ")).links;
}

/** "youtube.com", "twitch.tv": the site a link belongs to, for showing next to it. */
export function siteOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^(www|m)\./, "");
  } catch {
    return url;
  }
}

/** "youtube.com, twitch.tv and 2 more": the distinct sites in a list of links. */
export function describeSites(urls: readonly string[], max = 2): string {
  const sites = [...new Set(urls.map(siteOf))];
  const shown = sites.slice(0, max).join(", ");
  return sites.length > max ? `${shown} and ${sites.length - max} more` : shown;
}
