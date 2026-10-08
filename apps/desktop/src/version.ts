/** Set by the build (`MEDIAFORGE_VERSION`, taken from the release tag). Absent in dev and tests. */
declare const __MEDIAFORGE_VERSION__: string | undefined;

export const VERSION: string =
  typeof __MEDIAFORGE_VERSION__ === "string" ? __MEDIAFORGE_VERSION__ : "0.1.0";
