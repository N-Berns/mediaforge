/** Errors that usually mean yt-dlp's site code is out of date, so a newer build would fix them. */
const STALE_EXTRACTOR = [
  /unable to extract/i,
  /confirm you are on the latest version/i,
  /yt-dlp -U\b/,
  /please report this issue/i,
  /(nsig|signature) extraction failed/i,
  /http error 403/i,
];

export const UPDATE_HINT = "run: mediaforge update";

export const isStaleExtractorError = (message: string | undefined): boolean =>
  message !== undefined && STALE_EXTRACTOR.some((pattern) => pattern.test(message));

/** Add `run: mediaforge update` under an error that an update would probably fix. */
export const withUpdateHint = (message: string): string =>
  isStaleExtractorError(message) ? `${message}\n${UPDATE_HINT}` : message;
