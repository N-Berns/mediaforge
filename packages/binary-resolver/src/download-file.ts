import { createHash } from "node:crypto";
import { fsError, httpError, isFsError, offlineError, ToolInstallError } from "./errors.ts";
import type { FetchLike, InstallFs, WritableFile } from "./install-types.ts";

/** `fetch` that turns a network failure into an `offline` install error. */
export async function request(
  fetchFn: FetchLike,
  url: string,
  init?: Parameters<FetchLike>[1],
): Promise<Response> {
  try {
    return await fetchFn(url, init);
  } catch (error) {
    if (init?.signal?.aborted) throw error;
    throw offlineError(url);
  }
}

export interface DownloadFileOptions {
  url: string;
  /** Where the bytes go. Removed again if anything fails. */
  dest: string;
  fetch: FetchLike;
  fs: InstallFs;
  signal?: AbortSignal;
  onProgress?: (received: number, total: number | undefined) => void;
}

/** Stream a URL to `dest`, hashing as it goes. Returns the SHA-256 of what was written. */
export async function downloadFile(
  options: DownloadFileOptions,
): Promise<{ sha256: string; bytes: number }> {
  const { url, dest, fs } = options;
  const response = await request(options.fetch, url, { signal: options.signal });
  if (!response.ok) throw httpError(url, response.status);
  if (!response.body) {
    throw new ToolInstallError("http", `Empty response from ${url}.`, "Try again later.");
  }

  const total = Number(response.headers.get("content-length")) || undefined;
  const hash = createHash("sha256");
  let received = 0;
  let file: WritableFile | undefined;
  try {
    file = await fs.openWrite(dest);
    const reader = response.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      hash.update(value);
      await file.write(value);
      received += value.byteLength;
      options.onProgress?.(received, total);
    }
    await file.close();
    file = undefined;
  } catch (error) {
    await file?.close().catch(() => {});
    await fs.rm(dest).catch(() => {});
    if (options.signal?.aborted || error instanceof ToolInstallError) throw error;
    // A file system code means the disk is the problem; anything else is the connection.
    throw isFsError(error) ? fsError(error, dest) : offlineError(url);
  }
  return { sha256: hash.digest("hex"), bytes: received };
}
