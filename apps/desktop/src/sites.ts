import { ExitCode } from "./exit-codes.ts";

/** yt-dlp's list of every site it can download from. */
export const SUPPORTED_SITES_URL = "https://github.com/yt-dlp/yt-dlp/blob/master/supportedsites.md";

export const sitesTip = `Not sure a site works? Full list of supported sites: ${SUPPORTED_SITES_URL}`;

/** Extra line printed under an error, for the errors where it helps. */
export const errorTip = (code: ExitCode): string =>
  code === ExitCode.UnsupportedSite ? `Supported sites: ${SUPPORTED_SITES_URL}\n` : "";
