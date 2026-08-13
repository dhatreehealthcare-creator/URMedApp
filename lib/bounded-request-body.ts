/**
 * Razorpay webhook events are small JSON documents. 256 KiB leaves ample room
 * for provider metadata while bounding unauthenticated Worker memory use.
 */
export const RAZORPAY_WEBHOOK_MAX_BYTES = 256 * 1024;

export class RequestBodyTooLargeError extends Error {
  readonly maximumBytes: number;

  constructor(maximumBytes: number) {
    super(`Request body exceeds the ${maximumBytes}-byte limit`);
    this.name = "RequestBodyTooLargeError";
    this.maximumBytes = maximumBytes;
  }
}

function declaredLength(request: Request): number | null {
  const value = request.headers.get("content-length")?.trim() ?? "";
  if (!/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

export async function readBoundedRequestText(request: Request, maximumBytes: number): Promise<string> {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1) throw new Error("A positive request-body limit is required");
  const length = declaredLength(request);
  if (length !== null && length > maximumBytes) throw new RequestBodyTooLargeError(maximumBytes);
  if (!request.body) return "";

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maximumBytes) {
        await reader.cancel("request body limit exceeded").catch(() => undefined);
        throw new RequestBodyTooLargeError(maximumBytes);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}
