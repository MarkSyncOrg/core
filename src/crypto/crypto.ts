import lzutf8 from 'lzutf8';
import { base64ToBytes, bytesToBase64 } from './base64.js';

// Client-side encryption for xBrowserSync.
//
// IMPORTANT: this is a compatibility contract, not an implementation choice. The
// server stores the ciphertext verbatim and the wider xBrowserSync ecosystem (other
// clients, existing syncs) must be able to decrypt what we write. Changing any
// parameter below makes existing syncs unreadable. Do not touch without a migration.
//
// Format, end to end:
//   1. JSON string -> LZUTF8 compress -> bytes
//   2. AES-GCM encrypt with a random 16-byte IV
//   3. output = IV (16 bytes) ++ ciphertext, Base64-encoded
// Key derivation: PBKDF2(password, salt, 250000 iterations, SHA-256) -> AES-256 key,
// exported raw and Base64-encoded as the stored "password hash".
export const CRYPTO_PARAMS = {
  keyDerivationAlgorithm: 'PBKDF2',
  keyDerivationIterations: 250_000,
  keyDerivationHash: 'SHA-256',
  encryptionAlgorithm: 'AES-GCM',
  keyLengthBits: 256,
  ivLengthBytes: 16,
} as const;

/**
 * Derives the Base64-encoded password hash used as the AES key for a sync.
 *
 * Deterministic: the same password and salt always produce the same hash.
 *
 * @param password The user's sync password.
 * @param salt     The sync salt (the sync ID is used as the salt by convention).
 */
export async function getPasswordHash(password: string, salt: string): Promise<string> {
  const encoder = new TextEncoder();

  const baseKey = await crypto.subtle.importKey(
    'raw',
    encoder.encode(password),
    { name: CRYPTO_PARAMS.keyDerivationAlgorithm },
    false,
    ['deriveKey'],
  );

  const derivedKey = await crypto.subtle.deriveKey(
    {
      name: CRYPTO_PARAMS.keyDerivationAlgorithm,
      salt: encoder.encode(salt),
      iterations: CRYPTO_PARAMS.keyDerivationIterations,
      hash: CRYPTO_PARAMS.keyDerivationHash,
    },
    baseKey,
    { name: CRYPTO_PARAMS.encryptionAlgorithm, length: CRYPTO_PARAMS.keyLengthBits },
    true,
    ['encrypt', 'decrypt'],
  );

  const rawKey = await crypto.subtle.exportKey('raw', derivedKey);
  return bytesToBase64(new Uint8Array(rawKey));
}

/**
 * Encrypts data with the given password hash, returning Base64(IV ++ ciphertext).
 * Returns an empty string for empty input (mirrors the legacy client behaviour).
 */
export async function encryptData(data: string, passwordHash: string): Promise<string> {
  if (!data) {
    return '';
  }

  const key = await importAesKey(passwordHash, ['encrypt']);
  const iv = crypto.getRandomValues(new Uint8Array(CRYPTO_PARAMS.ivLengthBytes));
  // Copy into a fresh ArrayBuffer-backed array (lzutf8 types as ArrayBufferLike).
  const compressed = new Uint8Array(
    lzutf8.compress(data, { outputEncoding: 'ByteArray' }) as Uint8Array,
  );

  const ciphertext = await crypto.subtle.encrypt(
    { name: CRYPTO_PARAMS.encryptionAlgorithm, iv },
    key,
    compressed,
  );

  // Prepend the IV so decryption can recover it.
  const combined = new Uint8Array(iv.length + ciphertext.byteLength);
  combined.set(iv, 0);
  combined.set(new Uint8Array(ciphertext), iv.length);
  return bytesToBase64(combined);
}

/**
 * Decrypts Base64(IV ++ ciphertext) produced by {@link encryptData}.
 * Returns an empty string for empty input.
 *
 * @throws if the password hash is wrong or the data is corrupt (AES-GCM auth fails).
 */
export async function decryptData(encryptedData: string, passwordHash: string): Promise<string> {
  if (!encryptedData) {
    return '';
  }

  const combined = base64ToBytes(encryptedData);
  // Copy the slices so they are backed by their own ArrayBuffer (BufferSource).
  const iv = new Uint8Array(combined.subarray(0, CRYPTO_PARAMS.ivLengthBytes));
  const ciphertext = new Uint8Array(combined.subarray(CRYPTO_PARAMS.ivLengthBytes));

  const key = await importAesKey(passwordHash, ['decrypt']);
  const compressed = await crypto.subtle.decrypt(
    { name: CRYPTO_PARAMS.encryptionAlgorithm, iv },
    key,
    ciphertext,
  );

  return lzutf8.decompress(new Uint8Array(compressed), {
    inputEncoding: 'ByteArray',
    outputEncoding: 'String',
  }) as string;
}

/** Imports a Base64 password hash as a raw AES-GCM key for the given usages. */
function importAesKey(passwordHash: string, usages: KeyUsage[]): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    base64ToBytes(passwordHash),
    { name: CRYPTO_PARAMS.encryptionAlgorithm },
    false,
    usages,
  );
}
