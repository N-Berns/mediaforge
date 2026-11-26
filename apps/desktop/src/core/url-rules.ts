import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

/**
 * Rules for links that arrive from the browser. Only web links are fetched, and by default not
 * ones that point back at this machine or its local network, which a page could use to make the
 * downloader reach services that were never meant to be exposed to it.
 */

/** Resolves a host name to the addresses it points at. */
export type HostResolver = (host: string) => Promise<string[]>;

const resolveHost: HostResolver = async (host) =>
  (await lookup(host, { all: true, verbatim: true })).map((entry) => entry.address);

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

function isPrivateV4(address: string): boolean {
  const match = IPV4.exec(address);
  if (!match) return false;
  const [a = 0, b = 0] = [Number(match[1]), Number(match[2])];
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168)
  );
}

/** Loopback, unspecified, unique-local (fc00::/7) and link-local (fe80::/10) IPv6, and mapped IPv4. */
function isPrivateV6(address: string): boolean {
  const lower = address.toLowerCase();
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(lower);
  if (mapped) return isPrivateV4(mapped[1] as string);
  if (lower === "::" || lower === "::1") return true;
  return /^f[cd][0-9a-f]{2}:/.test(lower) || /^fe[89ab][0-9a-f]:/.test(lower);
}

/** True for an address in a loopback, private, link-local or otherwise non-public range. */
export function isPrivateAddress(address: string): boolean {
  const kind = isIP(address);
  return kind === 4 ? isPrivateV4(address) : kind === 6 && isPrivateV6(address);
}

const isLocalName = (host: string): boolean =>
  host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local");

/**
 * Why `url` may not be fetched, or undefined when it may. With `allowPrivate`, any http or https
 * link passes. Otherwise a host name is resolved too, so a name that points at a private address is
 * refused; a name that does not resolve is left for the downloader to report.
 */
export async function urlError(
  url: string,
  allowPrivate: boolean,
  resolver: HostResolver = resolveHost,
): Promise<string | undefined> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return "That is not a valid link.";
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return "Only http and https links can be downloaded.";
  }
  if (allowPrivate) return undefined;
  const refused =
    "That link points at this computer or its local network. Turn on allowPrivateUrls in the MediaForge settings to allow it.";
  const host = parsed.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (isLocalName(host) || isPrivateAddress(host)) return refused;
  if (isIP(host) !== 0) return undefined;
  try {
    if ((await resolver(host)).some(isPrivateAddress)) return refused;
  } catch {
    // Unresolvable: yt-dlp will report it.
  }
  return undefined;
}
