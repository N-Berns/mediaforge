import { createHash } from "node:crypto";
import type { FetchLike, InstallFs } from "./install-types.ts";

const norm = (path: string): string => path.replaceAll("\\", "/");

function concat(chunks: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.byteLength, 0));
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

const errno = (code: string, path: string) =>
  Object.assign(new Error(`${code}: ${path}`), { code });

/**
 * An in-memory `InstallFs`. Written data is visible after every chunk, like a real partial file.
 * Set `state.writeError` to make the next writes fail.
 */
export function memoryInstallFs(initial: Record<string, string> = {}) {
  const files = new Map<string, Uint8Array>();
  const modes = new Map<string, number>();
  const encoder = new TextEncoder();
  const state: { writeError?: Error } = {};
  for (const [path, text] of Object.entries(initial)) files.set(norm(path), encoder.encode(text));

  const fs: InstallFs = {
    mkdir: async () => {},
    openWrite: async (path) => {
      const chunks: Uint8Array[] = [];
      return {
        write: async (chunk) => {
          if (state.writeError) throw state.writeError;
          chunks.push(chunk.slice());
          files.set(norm(path), concat(chunks));
        },
        close: async () => {},
      };
    },
    rename: async (from, to) => {
      const data = files.get(norm(from));
      if (!data) throw errno("ENOENT", from);
      files.delete(norm(from));
      files.set(norm(to), data);
      const mode = modes.get(norm(from));
      if (mode !== undefined) {
        modes.delete(norm(from));
        modes.set(norm(to), mode);
      }
    },
    rm: async (path) => {
      const key = norm(path);
      files.delete(key);
      for (const existing of [...files.keys()]) {
        if (existing.startsWith(`${key}/`)) files.delete(existing);
      }
    },
    chmod: async (path, mode) => {
      if (!files.has(norm(path))) throw errno("ENOENT", path);
      modes.set(norm(path), mode);
    },
    readText: async (path) => {
      const data = files.get(norm(path));
      if (!data) throw errno("ENOENT", path);
      return new TextDecoder().decode(data);
    },
    writeText: async (path, data) => {
      files.set(norm(path), encoder.encode(data));
    },
    exists: async (path) => {
      const key = norm(path);
      return files.has(key) || [...files.keys()].some((k) => k.startsWith(`${key}/`));
    },
    listFiles: async (dir) => {
      const prefix = `${norm(dir)}/`;
      return [...files.keys()]
        .filter((k) => k.startsWith(prefix))
        .map((k) => k.slice(prefix.length));
    },
    sha256File: async (path) => {
      const data = files.get(norm(path));
      if (!data) throw errno("ENOENT", path);
      return createHash("sha256").update(data).digest("hex");
    },
  };

  return {
    fs,
    files,
    state,
    has: (path: string) => files.has(norm(path)),
    text: (path: string) => new TextDecoder().decode(files.get(norm(path))),
    mode: (path: string) => modes.get(norm(path)),
    /** All stored paths with `/` separators, sorted. */
    paths: () => [...files.keys()].sort(),
  };
}

/**
 * A 200 response whose body arrives in small chunks. With `failAfter`, the stream errors once that
 * many bytes were sent, like a dropped connection.
 */
export function streamResponse(data: string | Uint8Array, chunk = 4, failAfter?: number): Response {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
  let offset = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (failAfter !== undefined && offset >= failAfter) {
        controller.error(new TypeError("terminated"));
        return;
      }
      if (offset >= bytes.length) {
        controller.close();
        return;
      }
      controller.enqueue(bytes.slice(offset, offset + chunk));
      offset += chunk;
    },
  });
  return new Response(body, { status: 200, headers: { "content-length": String(bytes.length) } });
}

/** A fake `fetch` that answers from a table of exact URLs; anything else is a 404. */
export function routeFetch(routes: Record<string, () => Response | Promise<Response>>) {
  const calls: string[] = [];
  const fetchFn: FetchLike = async (url) => {
    calls.push(url);
    const route = routes[url];
    return route ? route() : new Response("not found", { status: 404 });
  };
  return Object.assign(fetchFn, { calls });
}
