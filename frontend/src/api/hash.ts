/** Lowercase hex SHA-256 of the UTF-8 bytes of `text` (for `x-amz-content-sha256`). */
export async function sha256Hex(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Headers required by CloudFront OAC → Lambda Function URL for a request with a body.
 * The hash must be computed over the exact string that is sent.
 */
export async function bodyHeaders(body: string): Promise<Record<string, string>> {
  return {
    'content-type': 'application/json',
    'x-amz-content-sha256': await sha256Hex(body),
  };
}
