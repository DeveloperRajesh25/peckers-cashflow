/**
 * Identity hand-off from middleware → server components.
 *
 * Middleware validates the session ONCE per request (local JWT signature
 * verification + the allowed_users lookup) and stashes the result in these
 * request headers so protected pages can render without repeating that work.
 *
 * SECURITY MODEL:
 *  - These headers are ALWAYS stripped from the incoming request and re-set
 *    from the freshly validated session in middleware, so a client cannot
 *    forge them on any route the middleware matcher covers.
 *  - Data access is governed by Postgres RLS on the real, signed JWT in the
 *    session cookie — NOT by these headers. A bad header value can at most
 *    influence UI/route rendering, never what rows a user can read or write.
 *  - Server actions (writes + service-role provisioning) deliberately do NOT
 *    trust these headers; they re-validate via getSessionUser().
 */

export const H_USER_ID = "x-pk-uid";
export const H_USER_EMAIL = "x-pk-email";
export const H_ALLOWED = "x-pk-allowed";

/**
 * UTF-8-safe base64 encode. Uses TextEncoder + btoa so it runs in the Edge
 * runtime (where `Buffer` is unavailable) as well as in Node.
 */
export function encodeIdentity(obj: unknown): string {
  const json = JSON.stringify(obj);
  const bytes = new TextEncoder().encode(json);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

/** Inverse of {@link encodeIdentity}. Returns null on any malformed input. */
export function decodeIdentity<T>(value: string | null | undefined): T | null {
  if (!value) return null;
  try {
    const binary = atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    const json = new TextDecoder().decode(bytes);
    return JSON.parse(json) as T;
  } catch {
    return null;
  }
}
