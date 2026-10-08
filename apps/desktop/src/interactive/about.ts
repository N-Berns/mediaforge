/** Shown on the About page. */
export const DEVELOPER = "N-Berns";

/** Set to the repository link once it is public; the About page hides the row until then. */
export const REPO_URL: string | undefined = undefined;

/** The tools MediaForge downloads and runs, with the license each one is distributed under. */
export const NOTICES = [
  { name: "yt-dlp", license: "Unlicense (public domain)", url: "https://github.com/yt-dlp/yt-dlp" },
  {
    name: "ffmpeg",
    license: "LGPL 2.1 or later (some builds GPL)",
    url: "https://ffmpeg.org/legal.html",
  },
] as const;

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
