// Bounded request body reading (for JSON write endpoints whose request has no Content-Length, e.g. chunked).
// Reads the stream and stops as soon as more than `max` bytes have arrived (-> tooLarge), instead of letting request.json() buffer everything.

/** -> { tooLarge: true } | { bytes: Uint8Array } | { bytes: null } (no body) */
export async function readBodyLimited(request, max) {
  if (!request.body) return { bytes: null };
  const reader = request.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > max) {
      try { await reader.cancel(); } catch { /* ignore */ }
      return { tooLarge: true };
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) { bytes.set(c, o); o += c.length; }
  return { bytes };
}

/** A Request equal to `request` whose body is the already-read bytes (handlers keep calling request.json()). */
export function rebuildRequest(request, bytes) {
  const headers = new Headers(request.headers);
  headers.delete('Content-Length');
  return new Request(request.url, { method: request.method, headers, body: bytes });
}
