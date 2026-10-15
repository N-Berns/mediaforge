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

/** The Google Form that receives bug reports, and the question each field answers. */
export const REPORT_FORM = {
  url: "https://docs.google.com/forms/d/e/1FAIpQLScjjDvivMbdPn9-pln_QhLeDjEvMFuyAWi23ytMWlY_jygpQg/formResponse",
  fields: {
    description: "entry.1198735351",
    type: "entry.1734103031",
    extensionVersion: "entry.138150986",
    appVersion: "entry.10504913",
    os: "entry.2109461094",
    browser: "entry.980995130",
    details: "entry.813629248",
  },
} as const;

/** The form is a text field, so a runaway log must not turn into a huge request. */
export const MAX_DESCRIPTION = 2000;
export const MAX_DETAILS = 8000;

export const REPORT_TYPES = ["Extension", "App"] as const;
export type ReportType = (typeof REPORT_TYPES)[number];

export interface Report {
  description: string;
  type: ReportType;
  extensionVersion: string;
  appVersion: string;
  os: string;
  browser: string;
  /** Diagnostics text, or undefined when the user chose not to include it. */
  details?: string | undefined;
}

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

/** The urlencoded body Google Forms expects. Fields are clipped to the limits above. */
export function buildReportBody(report: Report, fields = REPORT_FORM.fields): URLSearchParams {
  const body = new URLSearchParams();
  body.set(fields.description, report.description.trim().slice(0, MAX_DESCRIPTION));
  body.set(fields.type, report.type);
  body.set(fields.extensionVersion, report.extensionVersion);
  body.set(fields.appVersion, report.appVersion);
  body.set(fields.os, report.os);
  body.set(fields.browser, report.browser);
  body.set(fields.details, (report.details ?? "(not included)").slice(0, MAX_DETAILS));
  return body;
}

export type SendResult = { ok: true } | { ok: false; message: string };

/** Posts the report. The form answers with a page, so only the status code is checked. */
export async function sendReport(report: Report, post: typeof fetch = fetch): Promise<SendResult> {
  if (report.description.trim() === "") {
    return { ok: false, message: "Describe what went wrong first." };
  }
  try {
    const response = await post(REPORT_FORM.url, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: buildReportBody(report),
      credentials: "omit",
    });
    if (!response.ok)
      return { ok: false, message: `The report was not accepted (${response.status}).` };
    return { ok: true };
  } catch {
    return {
      ok: false,
      message: "Could not send the report. Check your connection and try again.",
    };
  }
}
