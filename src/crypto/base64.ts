// Base64 <-> byte-array helpers that work in both the service worker and Node test
// environments (they rely only on the global btoa/atob, not on Buffer).

/** Encodes a byte array as a Base64 string. */
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  // Chunk to stay well under the argument-count limit of String.fromCharCode.
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

/** Decodes a Base64 string into a byte array. */
export function base64ToBytes(base64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}
