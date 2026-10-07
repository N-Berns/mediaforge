/**
 * Native-messaging framing: each message is UTF-8 JSON preceded by a 32-bit
 * length in native byte order (little-endian on every platform we target).
 * Uses Uint8Array/DataView, not Buffer, so the extension can share it.
 */

/** Chrome rejects host → extension messages larger than 1 MB. */
export const MAX_HOST_MESSAGE_BYTES = 1024 * 1024;
/** Chrome caps extension → host messages at 64 MiB. */
export const MAX_EXTENSION_MESSAGE_BYTES = 64 * 1024 * 1024;

const HEADER_BYTES = 4;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

export class FramingError extends Error {
  override name = "FramingError";
}

export function encodeMessage(message: unknown, maxBytes = MAX_HOST_MESSAGE_BYTES): Uint8Array {
  const body = encoder.encode(JSON.stringify(message));
  if (body.byteLength > maxBytes) {
    throw new FramingError(`Message is ${body.byteLength} bytes; limit is ${maxBytes}`);
  }
  const frame = new Uint8Array(HEADER_BYTES + body.byteLength);
  new DataView(frame.buffer).setUint32(0, body.byteLength, true);
  frame.set(body, HEADER_BYTES);
  return frame;
}

export interface MessageDecoder {
  /** Feed raw bytes; returns every message completed by this chunk. */
  push(chunk: Uint8Array): unknown[];
  /** Bytes buffered for an incomplete message. */
  readonly pending: number;
}

export function createDecoder(maxBytes = MAX_EXTENSION_MESSAGE_BYTES): MessageDecoder {
  let buffer = new Uint8Array(0);

  return {
    get pending() {
      return buffer.byteLength;
    },
    push(chunk) {
      if (chunk.byteLength > 0) {
        const merged = new Uint8Array(buffer.byteLength + chunk.byteLength);
        merged.set(buffer);
        merged.set(chunk, buffer.byteLength);
        buffer = merged;
      }

      const messages: unknown[] = [];
      while (buffer.byteLength >= HEADER_BYTES) {
        const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
        const length = view.getUint32(0, true);
        if (length > maxBytes) {
          buffer = new Uint8Array(0);
          throw new FramingError(`Incoming message is ${length} bytes; limit is ${maxBytes}`);
        }
        if (buffer.byteLength < HEADER_BYTES + length) break;

        const body = buffer.subarray(HEADER_BYTES, HEADER_BYTES + length);
        buffer = buffer.subarray(HEADER_BYTES + length);
        try {
          messages.push(JSON.parse(decoder.decode(body)));
        } catch (cause) {
          throw new FramingError("Message body is not valid JSON", { cause });
        }
      }
      return messages;
    },
  };
}
