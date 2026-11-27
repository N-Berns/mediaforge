/** Name the browser uses to find the native messaging host. Fixed so the installer can register it. */
export const NATIVE_HOST_NAME = "com.mediaforge.host";

/** Firefox add-on ID. The native host manifest allows only this ID. */
export const FIREFOX_ADDON_ID = "mediaforge@n-berns";

/**
 * Chrome Web Store item ID. Empty until the store item exists: while it is, setup registers no
 * store origin and writes no external-install entry.
 */
export const CHROME_STORE_ID: string = "";

/**
 * Public key (base64 DER) that fixes the ID of the unpacked Chromium build. The store refuses a
 * manifest that carries `key`, so only the unpacked build gets it. Empty until generated.
 */
export const CHROMIUM_PUBLIC_KEY: string =
  "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEApEl98YsCkXfYyASIn+2mSj3q4rHI/4ihqaBctFEPPMF5dEHm05QqJxkK+VmwiyXpOvFnCTYyAi77F/neNKGIV4M1V4LeDaTfD+uAMojMfBja/nRjPlv0XaSJsYhe4adGsnzSOs1Ifg+8HdtC732MlFmBbVvPV7Gr52ZaMRbNhyyVKKxzx5fgaEkSTizBw2U8mdZKcbVonZn+eVV8rU0uTMiO1V0RRX1OmwkgH2gufXGsbS7auLvdUeRMpMTSHeu4zye23lIc17ANaoZ40A3X4uDgjDobJJgZ+gG4cSkMftbsyOtFu6VvlgPO7E+wzHvECKbjlZfmEYgiBLDH0B5pHQIDAQAB";

/** ID of the unpacked Chromium build, derived from `CHROMIUM_PUBLIC_KEY` (a test checks it). */
export const CHROMIUM_UNPACKED_ID: string = "nelipnicbcpeenpdoldceeaiilafdail";

/** The Chromium extension IDs the native host accepts: the store's and the unpacked build's. */
export const CHROMIUM_EXTENSION_IDS: readonly string[] = [
  CHROME_STORE_ID,
  CHROMIUM_UNPACKED_ID,
].filter(Boolean);
