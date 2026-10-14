import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import net from "node:net";
import { homedir, tmpdir, userInfo } from "node:os";
import { dirname, join } from "node:path";
import {
  createDecoder,
  encodeMessage,
  MAX_EXTENSION_MESSAGE_BYTES,
  MAX_HOST_MESSAGE_BYTES,
} from "@mediaforge/shared-protocol";
import { settingsPath } from "../settings.ts";

/** A framed, already-authenticated link between a client and the core. */
export interface Connection {
  send(message: unknown): void;
  onMessage(handler: (message: unknown) => void): void;
  onClose(handler: () => void): void;
  close(): void;
}

const HANDSHAKE_TIMEOUT_MS = 5000;

/**
 * Largest frame either side accepts while the handshake is open. A nonce, a proof or an
 * acknowledgement is far smaller, and an unauthenticated peer must not be able to make the other
 * side buffer more.
 */
export const HANDSHAKE_MAX_BYTES = 4096;

/** Most clients the core serves at once; extra connections are dropped by the server. */
const MAX_CONNECTIONS = 32;

const unsafeChars = /[^A-Za-z0-9_.-]/gu;

/** `%XX` per UTF-8 byte, or `%uXXXX` for a lone surrogate, which has no UTF-8 form. */
function escapeChar(char: string): string {
  const unit = char.charCodeAt(0);
  if (char.length === 1 && unit >= 0xd800 && unit <= 0xdfff) {
    return `%u${unit.toString(16).padStart(4, "0")}`;
  }
  return Array.from(Buffer.from(char), (byte) => `%${byte.toString(16).padStart(2, "0")}`)
    .join("")
    .toUpperCase();
}

/** Percent-encode everything but `A-Za-z0-9_.-`, so two different names never share a path. */
const safeName = (name: string) => name.replace(unsafeChars, escapeChar);

function currentUser(): string {
  try {
    return userInfo().username;
  } catch {
    return "user";
  }
}

/** Where the core listens. One per user, so two Windows accounts never share a core. */
export function pipePath(
  platform: NodeJS.Platform,
  env: Record<string, string | undefined>,
  username: string = currentUser(),
): string {
  const name = `mediaforge-${safeName(username)}`;
  if (platform === "win32") return `\\\\.\\pipe\\${name}`;
  return join(env.XDG_RUNTIME_DIR ?? tmpdir(), `${name}.sock`);
}

/** The per-user token file, in the same folder as the settings file. */
export function tokenPath(
  env: Record<string, string | undefined>,
  platform: NodeJS.Platform = process.platform,
  home: string = homedir(),
): string {
  return join(dirname(settingsPath(env, platform, home)), "core.token");
}

export const newToken = (): string => randomBytes(32).toString("hex");

export async function writeToken(path: string, token: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  // Write then rename, so a relay reading during a core restart never sees a truncated token.
  const temp = `${path}.tmp`;
  await writeFile(temp, token, { encoding: "utf8", mode: 0o600 });
  await rename(temp, path);
}

export async function readToken(path: string): Promise<string | undefined> {
  try {
    return (await readFile(path, "utf8")).trim() || undefined;
  } catch {
    return undefined;
  }
}

/** Node types socket `data` as `string | Buffer`; it is only a string after `setEncoding`. */
const toBytes = (chunk: string | Buffer): Uint8Array =>
  typeof chunk === "string" ? Buffer.from(chunk) : chunk;

const FRAME_HEADER_BYTES = 4;

interface Frame {
  message: unknown;
  /** Bytes that arrived behind the frame, in the same chunk. */
  rest: Uint8Array;
}

/**
 * Read exactly one handshake frame from a socket that is not wrapped yet, bounded by `maxBytes`.
 * Rejects when the peer sends an oversized or malformed frame, or closes first. Unless
 * `allowRest`, it also rejects when anything arrives behind that frame: in the handshake a peer
 * must wait for the reply before it speaks again. On settling this has detached every listener it
 * added, so the socket can be handed to `wrapSocket`.
 */
function readFrame(socket: net.Socket, maxBytes: number, allowRest = false): Promise<Frame> {
  return new Promise((resolve, reject) => {
    let buffer = Buffer.alloc(0);
    const stop = () => {
      socket.off("data", onData);
      socket.off("close", onClose);
      socket.off("error", onError);
      // Hold later bytes in the socket until the next reader, or `wrapSocket`, resumes it.
      socket.pause();
    };
    const onData = (chunk: string | Buffer) => {
      buffer = Buffer.concat([buffer, toBytes(chunk)]);
      if (buffer.byteLength < FRAME_HEADER_BYTES) return;
      const length = buffer.readUInt32LE(0);
      if (length > maxBytes) {
        stop();
        reject(new Error(`Handshake frame is ${length} bytes; limit is ${maxBytes}.`));
        return;
      }
      const end = FRAME_HEADER_BYTES + length;
      if (buffer.byteLength < end) return;
      stop();
      const rest = buffer.subarray(end);
      if (rest.byteLength > 0 && !allowRest) {
        reject(new Error("The peer sent more than the handshake frame."));
        return;
      }
      // The decoder of exactly one whole frame parses it, or throws on bad JSON.
      let messages: unknown[];
      try {
        messages = createDecoder(maxBytes).push(buffer.subarray(0, end));
      } catch (error) {
        reject(error);
        return;
      }
      resolve({ message: messages[0], rest });
    };
    const onClose = () => {
      stop();
      reject(new Error("The connection closed during the handshake."));
    };
    const onError = (error: Error) => {
      stop();
      reject(error);
    };
    socket.on("data", onData);
    socket.on("close", onClose);
    socket.on("error", onError);
    socket.resume();
  });
}

interface WrapOptions {
  /** Largest frame this side may send. */
  maxSendBytes?: number;
  /** Largest frame this side accepts; a larger one destroys the socket. */
  maxReceiveBytes?: number;
  /** Bytes already read off the socket, which the peer sent right behind the handshake. */
  initial?: Uint8Array;
}

/**
 * Frame an already-authenticated socket. Frames that arrive before `onMessage` is called are
 * queued and delivered on registration, and a close that happened before `onClose` is called is
 * reported on registration, so the owner can set handlers up at its own pace.
 */
export function wrapSocket(socket: net.Socket, options: WrapOptions = {}): Connection {
  const maxSendBytes = options.maxSendBytes ?? MAX_HOST_MESSAGE_BYTES;
  const decoder = createDecoder(options.maxReceiveBytes ?? MAX_EXTENSION_MESSAGE_BYTES);
  const queue: unknown[] = [];
  let messageHandler: ((message: unknown) => void) | undefined;
  let closeHandler: (() => void) | undefined;
  let closed = false;
  let closeReported = false;

  const flush = () => {
    while (messageHandler && queue.length > 0) messageHandler(queue.shift());
    if (closed && closeHandler && !closeReported) {
      closeReported = true;
      closeHandler();
    }
  };

  const receive = (bytes: Uint8Array) => {
    let messages: unknown[];
    try {
      messages = decoder.push(bytes);
    } catch {
      queue.length = 0;
      socket.destroy();
      return;
    }
    for (const message of messages) queue.push(message);
    flush();
  };

  if (options.initial && options.initial.byteLength > 0) receive(options.initial);
  socket.on("data", (chunk) => receive(toBytes(chunk)));
  socket.on("close", () => {
    closed = true;
    flush();
  });
  socket.on("error", () => socket.destroy());
  // The handshake readers pause the socket between frames.
  socket.resume();

  return {
    send(message) {
      if (!socket.destroyed) socket.write(encodeMessage(message, maxSendBytes));
    },
    onMessage(handler) {
      messageHandler = handler;
      // Not inline: the caller is usually still registering its other handlers.
      queueMicrotask(flush);
    },
    onClose(handler) {
      closeHandler = handler;
      queueMicrotask(flush);
    },
    close() {
      socket.end();
    },
  };
}

/*
 * Handshake: mutual challenge-response, so the token never crosses the pipe and a process that
 * squats the pipe name before the real core learns nothing it can use.
 *
 *   1. client -> core  { hello: nonceC }
 *   2. core -> client  { proof: HMAC(token, "core|" + nonceC), nonce: nonceS }
 *   3. the client checks the core's proof, and drops the core without another word if it is wrong
 *   4. client -> core  { proof: HMAC(token, "client|" + nonceS + "|" + nonceC) }
 *   5. core -> client  { ok: true }, once it has checked the client's proof
 *
 * Nonces are 32 random bytes in lower-case hex, and nonceS is fresh per connection, so a captured
 * step-4 proof is useless on another connection. The "core|" and "client|" prefixes keep a proof
 * the core hands out at step 2 from ever being a valid step-4 proof.
 */

const NONCE_BYTES = 32;
/** A nonce or an HMAC-SHA256 in lower-case hex; both are 32 bytes. */
const HEX_32_BYTES = /^[0-9a-f]{64}$/u;

const newNonce = () => randomBytes(NONCE_BYTES).toString("hex");
const mac = (token: string, data: string) => createHmac("sha256", token).update(data).digest("hex");
const coreProof = (token: string, nonceC: string) => mac(token, `core|${nonceC}`);
const clientProof = (token: string, nonceS: string, nonceC: string) =>
  mac(token, `client|${nonceS}|${nonceC}`);

/** `value[key]` when `value` is a plain object holding a 32-byte hex string there. */
function hexField(value: unknown, key: string): string | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const field = (value as Record<string, unknown>)[key];
  return typeof field === "string" && HEX_32_BYTES.test(field) ? field : undefined;
}

/** Constant-time comparison of two hex MACs; lengths are checked first, as `timingSafeEqual` needs. */
function proofMatches(given: string | undefined, expected: string): boolean {
  if (given === undefined) return false;
  const a = Buffer.from(given, "hex");
  const b = Buffer.from(expected, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}

export interface ListenOptions {
  path: string;
  token: string;
  /** Called once per authenticated client. */
  onConnection: (conn: Connection) => void;
}

/**
 * Start the core's server. Rejects with `EADDRINUSE` when another core already holds the pipe,
 * which is how a second instance learns it is not needed.
 *
 * Each client runs the handshake described above before `onConnection` sees it. Every handshake
 * frame is at most `HANDSHAKE_MAX_BYTES` and must arrive alone, and the whole handshake must finish
 * within 5 s. A client that breaks any rule is disconnected without an error reply, so a probing
 * client cannot tell one failure from another.
 */
export function listenCore({ path, token, onConnection }: ListenOptions): Promise<net.Server> {
  if (token === "") return Promise.reject(new Error("The core token must not be empty."));

  const authenticate = async (socket: net.Socket): Promise<boolean> => {
    const hello = await readFrame(socket, HANDSHAKE_MAX_BYTES);
    const nonceC = hexField(hello.message, "hello");
    if (nonceC === undefined) return false;
    const nonceS = newNonce();
    socket.write(
      encodeMessage({ proof: coreProof(token, nonceC), nonce: nonceS }, HANDSHAKE_MAX_BYTES),
    );
    const reply = await readFrame(socket, HANDSHAKE_MAX_BYTES);
    return proofMatches(hexField(reply.message, "proof"), clientProof(token, nonceS, nonceC));
  };

  return new Promise((resolve, reject) => {
    const server = net.createServer((socket) => {
      socket.on("error", () => socket.destroy());
      const timer = setTimeout(() => socket.destroy(), HANDSHAKE_TIMEOUT_MS);
      authenticate(socket).then(
        (ok) => {
          clearTimeout(timer);
          if (!ok || socket.destroyed) {
            socket.destroy();
            return;
          }
          const conn = wrapSocket(socket);
          conn.send({ ok: true });
          onConnection(conn);
        },
        () => {
          clearTimeout(timer);
          socket.destroy();
        },
      );
    });
    server.maxConnections = MAX_CONNECTIONS;
    server.once("error", reject);
    server.listen(path, () => {
      server.off("error", reject);
      resolve(server);
    });
  });
}

export interface ConnectOptions {
  path: string;
  token: string;
  /** How long to wait for the core to answer the handshake. Defaults to 5000 ms. */
  timeoutMs?: number;
}

/**
 * Connect and run the handshake described above. Rejects when nothing listens, the core cannot
 * prove it holds the token (another process squats the pipe, or the tokens differ), the core
 * refuses this client, or the whole handshake takes longer than `timeoutMs`. The token itself is
 * never sent.
 */
export function connectCore({
  path,
  token,
  timeoutMs = HANDSHAKE_TIMEOUT_MS,
}: ConnectOptions): Promise<Connection> {
  return new Promise((resolve, reject) => {
    const nonceC = newNonce();
    const socket = net.connect(path);
    const timer = setTimeout(
      () => socket.destroy(new Error("Timed out waiting for the core to answer.")),
      timeoutMs,
    );
    let settled = false;
    const fail = (error: Error) => {
      clearTimeout(timer);
      socket.destroy();
      if (!settled) reject(error);
      settled = true;
    };

    const authenticate = async (): Promise<Uint8Array> => {
      socket.write(encodeMessage({ hello: nonceC }, HANDSHAKE_MAX_BYTES));
      const challenge = await readFrame(socket, HANDSHAKE_MAX_BYTES);
      const nonceS = hexField(challenge.message, "nonce");
      // Checked before anything else is sent: a squatter gets the hello and nothing more.
      if (
        nonceS === undefined ||
        !proofMatches(hexField(challenge.message, "proof"), coreProof(token, nonceC))
      ) {
        throw new Error("Core could not prove its identity.");
      }
      socket.write(
        encodeMessage({ proof: clientProof(token, nonceS, nonceC) }, HANDSHAKE_MAX_BYTES),
      );
      // The core may start talking right behind its confirmation; those bytes are kept.
      const confirmation = await readFrame(socket, HANDSHAKE_MAX_BYTES, true);
      const { message } = confirmation;
      if (
        typeof message !== "object" ||
        message === null ||
        (message as { ok?: unknown }).ok !== true
      ) {
        throw new Error("Core refused the handshake.");
      }
      return confirmation.rest;
    };

    socket.once("error", fail);
    socket.once("connect", () => {
      authenticate().then((rest) => {
        if (settled || socket.destroyed) {
          fail(new Error("The connection closed during the handshake."));
          return;
        }
        clearTimeout(timer);
        settled = true;
        const conn = wrapSocket(socket, {
          maxSendBytes: MAX_EXTENSION_MESSAGE_BYTES,
          maxReceiveBytes: MAX_HOST_MESSAGE_BYTES,
          initial: rest,
        });
        socket.off("error", fail);
        resolve(conn);
      }, fail);
    });
  });
}
