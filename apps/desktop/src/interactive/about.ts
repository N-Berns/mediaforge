/** Shown on the About page. */
export const DEVELOPER = "N-Berns";

/** Shown on the About page. Leave it undefined to hide the row. */
export const REPO_URL: string | undefined = "https://github.com/N-Berns/mediaforge";

/** Mouse capture is always on; this is how text is selected anyway. */
export const SELECT_TIP = "Shift+drag selects text in Windows Terminal and most Linux terminals.";

/** The tools MediaForge downloads and runs, with the license each one is distributed under. */
export const NOTICES = [
  {
    name: "yt-dlp",
    license: "Unlicense (public domain)",
    short: "Unlicense",
    url: "https://github.com/yt-dlp/yt-dlp",
  },
  {
    name: "ffmpeg",
    license: "LGPL 2.1 or later (some builds GPL)",
    short: "LGPL 2.1+",
    url: "https://ffmpeg.org/legal.html",
  },
  { name: "deno", license: "MIT", short: "MIT", url: "https://github.com/denoland/deno" },
] as const;

/** One line for a short window; the full notices are on the repository page. */
export const NOTICE_SUMMARY = `Licenses: ${NOTICES.map((n) => `${n.name} (${n.short})`).join(", ")}. Full notices are in the repository.`;

export interface AboutInfo {
  version: string;
  target: string;
  configPath: string;
}

export const aboutRows = ({ version, target, configPath }: AboutInfo): [string, string][] => [
  ["Version", version],
  ["Build", target],
  ["Settings file", configPath],
];

export const developerRows = (repo: string | undefined = REPO_URL): [string, string][] => [
  ["Developer", DEVELOPER],
  ...(repo ? ([["Repository", repo]] as [string, string][]) : []),
];
