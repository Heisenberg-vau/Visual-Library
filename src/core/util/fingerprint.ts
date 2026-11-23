/**
 * Identifies a file's content cheaply: SHA-256 of size + first 1 MB + last 1 MB.
 * (pdf.js's own fingerprint collides for PDFs without a trailer /ID, since it
 * then hashes only the first 1 KB.)
 */
export async function fileFingerprint(file: Blob): Promise<string> {
  const MB = 1024 * 1024;
  const head = new Uint8Array(await file.slice(0, MB).arrayBuffer());
  const tail = file.size > 2 * MB ? new Uint8Array(await file.slice(file.size - MB).arrayBuffer()) : new Uint8Array();
  const sizeBytes = new TextEncoder().encode(`${file.size}:`);
  const all = new Uint8Array(sizeBytes.length + head.length + tail.length);
  all.set(sizeBytes, 0);
  all.set(head, sizeBytes.length);
  all.set(tail, sizeBytes.length + head.length);
  const digest = await crypto.subtle.digest("SHA-256", all);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
