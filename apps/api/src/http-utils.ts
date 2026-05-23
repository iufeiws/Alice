export class HttpJsonError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message = code
  ) {
    super(message);
    this.name = "HttpJsonError";
  }
}

export function isAdminPath(url: string | undefined): boolean {
  return url === "/admin" || Boolean(url?.startsWith("/admin/api/"));
}

export function isLoopbackAddress(remoteAddress: string | undefined): boolean {
  return remoteAddress === "127.0.0.1" ||
    remoteAddress === "::1" ||
    remoteAddress === "::ffff:127.0.0.1";
}

export function assertLoopbackAdminRequest(request: any): void {
  if (!isAdminPath(request.url)) return;
  if (!isLoopbackAddress(request.socket?.remoteAddress)) {
    throw new HttpJsonError(403, "admin_local_only", "Admin endpoints are local-only");
  }
}

export async function readJsonBody(
  request: AsyncIterable<unknown>,
  options: { maxBytes?: number } = {}
): Promise<Record<string, unknown>> {
  const maxBytes = options.maxBytes ?? 64 * 1024;
  const chunks: Buffer[] = [];
  let bytes = 0;

  for await (const chunk of request) {
    const buffer = typeof chunk === "string" ? Buffer.from(chunk) : Buffer.from(chunk as any);
    bytes += buffer.length;
    if (bytes > maxBytes) {
      throw new HttpJsonError(413, "request_too_large", "JSON request body is too large");
    }
    chunks.push(buffer);
  }

  if (chunks.length === 0) return {};

  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpJsonError(400, "invalid_json", "Request body must be valid JSON");
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new HttpJsonError(400, "invalid_json_object", "Request body must be a JSON object");
  }

  return parsed as Record<string, unknown>;
}
