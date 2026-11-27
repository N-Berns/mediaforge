/** Shown in the About section. */
export const DEVELOPER = "N-Berns";
export const REPO_URL = "https://github.com/N-Berns/mediaforge";

/** The add-on page where users leave a review. Leave it undefined to hide the link. */
export const REVIEW_URL: string | undefined = undefined;

/** The tools MediaForge downloads and runs, with the license each one is distributed under. */
export const NOTICES = [
  { name: "yt-dlp", license: "Unlicense (public domain)", url: "https://github.com/yt-dlp/yt-dlp" },
  {
    name: "ffmpeg",
    license: "LGPL 2.1 or later (some builds GPL)",
    url: "https://ffmpeg.org/legal.html",
  },
  { name: "deno", license: "MIT", url: "https://github.com/denoland/deno" },
] as const;

export {
  buildReportBody,
  MAX_DESCRIPTION,
  MAX_DETAILS,
  REPORT_FORM,
  REPORT_TYPES,
  type Report,
  type ReportType,
  type SendResult,
  sendReport,
} from "@mediaforge/shared-types";

const WINDOWS_NT: Record<string, string> = {
  "10.0": "Windows 10/11",
  "6.3": "Windows 8.1",
  "6.2": "Windows 8",
  "6.1": "Windows 7",
};

/** "Windows 10/11", "macOS", "Linux" and so on, from a user agent. Never throws. */
export function osFromUserAgent(ua: string): string {
  const windows = /Windows NT (\d+\.\d+)/.exec(ua);
  if (windows) return WINDOWS_NT[windows[1] ?? ""] ?? "Windows";
  if (/Android/i.test(ua)) return "Android";
  if (/iPhone|iPad|iPod/.test(ua)) return "iOS";
  if (/Mac OS X|Macintosh/.test(ua)) return "macOS";
  if (/CrOS/.test(ua)) return "ChromeOS";
  if (/Linux|X11/.test(ua)) return "Linux";
  return "unknown";
}

/**
 * What a bug report sends, in Firefox's data-collection terms: versions and tool status
 * (technical), and the tab's and detected media's addresses (browsing activity). The Firefox
 * manifest lists the same categories as optional.
 */
export const REPORT_DATA_COLLECTION = ["technicalAndInteraction", "browsingActivity"] as const;

/** Firefox asks users for data-collection consent from this version on. */
const FIREFOX_CONSENT_VERSION = 140;

interface PermissionsApi {
  request(permissions: { data_collection: string[] }): Promise<boolean>;
}

/**
 * Whether the report may be sent. Firefox 140 and later asks the user once (later calls answer at
 * once); a refusal or an error means no. Other browsers, and older Firefox, have no such consent.
 * Call it first thing in the click handler: Firefox only asks during a user action.
 */
export function allowReport(permissions: PermissionsApi, userAgent: string): Promise<boolean> {
  const firefox = /Firefox\/(\d+)/.exec(userAgent);
  if (!firefox || Number(firefox[1]) < FIREFOX_CONSENT_VERSION) return Promise.resolve(true);
  try {
    return Promise.resolve(
      permissions.request({ data_collection: [...REPORT_DATA_COLLECTION] }),
    ).catch(() => false);
  } catch {
    return Promise.resolve(false);
  }
}

/** "Firefox 128.0", "Edge 126", "Chrome 126" and so on, from a user agent. Never throws. */
export function browserFromUserAgent(ua: string): string {
  const known: Array<[string, RegExp]> = [
    ["Edge", /Edg(?:e|A|iOS)?\/([\d.]+)/],
    ["Opera", /OPR\/([\d.]+)/],
    ["Firefox", /Firefox\/([\d.]+)/],
    ["Chrome", /Chrome\/([\d.]+)/],
    ["Safari", /Version\/([\d.]+).*Safari/],
  ];
  for (const [name, pattern] of known) {
    const match = pattern.exec(ua);
    if (match) return `${name} ${match[1]}`;
  }
  return "unknown";
}
