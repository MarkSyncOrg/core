import { describe, expect, it } from 'vitest';
import { base64ToBytes } from './base64';
import { CRYPTO_PARAMS, decryptData, encryptData, getPasswordHash } from './crypto';

describe('getPasswordHash', () => {
  it('is deterministic for the same password and salt', async () => {
    const a = await getPasswordHash('correct horse', 'salt-1');
    const b = await getPasswordHash('correct horse', 'salt-1');
    expect(a).toBe(b);
  });

  it('differs when the salt differs', async () => {
    const a = await getPasswordHash('correct horse', 'salt-1');
    const b = await getPasswordHash('correct horse', 'salt-2');
    expect(a).not.toBe(b);
  });

  it('differs when the password differs', async () => {
    const a = await getPasswordHash('correct horse', 'salt-1');
    const b = await getPasswordHash('battery staple', 'salt-1');
    expect(a).not.toBe(b);
  });

  it('produces a 256-bit (32-byte) key', async () => {
    const hash = await getPasswordHash('correct horse', 'salt-1');
    expect(base64ToBytes(hash)).toHaveLength(CRYPTO_PARAMS.keyLengthBits / 8);
  });

  it('matches a known-answer vector (guards the derivation parameters)', async () => {
    // Computed independently with PBKDF2(250000, SHA-256) -> AES-256 raw key.
    // If this fails, the crypto parameters changed and existing syncs would break.
    const hash = await getPasswordHash('password', 'salt');
    expect(hash).toBe('SF+0IQyILGs7QS7bg2PxEa/MT+RnI/6YgWRZ6H5Fgxc=');
  });
});

describe('encryptData / decryptData', () => {
  it('round-trips data', async () => {
    const hash = await getPasswordHash('pw', 'sync-id');
    const plaintext = JSON.stringify({
      bookmarks: [{ title: 'xBrowserSync', url: 'https://www.xbrowsersync.org' }],
    });

    const encrypted = await encryptData(plaintext, hash);
    expect(encrypted).not.toBe(plaintext);
    expect(await decryptData(encrypted, hash)).toBe(plaintext);
  });

  it('round-trips unicode', async () => {
    const hash = await getPasswordHash('pw', 'sync-id');
    const plaintext = '日本語 — émojis 🔐🚀 — ўкраїнська';
    expect(await decryptData(await encryptData(plaintext, hash), hash)).toBe(plaintext);
  });

  it('uses a random IV, so the same input yields different ciphertext', async () => {
    const hash = await getPasswordHash('pw', 'sync-id');
    const a = await encryptData('same data', hash);
    const b = await encryptData('same data', hash);
    expect(a).not.toBe(b);
  });

  it('prepends a 16-byte IV', async () => {
    const hash = await getPasswordHash('pw', 'sync-id');
    const encrypted = await encryptData('x', hash);
    // IV + AES-GCM ciphertext (>= compressed length + 16-byte auth tag).
    expect(base64ToBytes(encrypted).length).toBeGreaterThan(CRYPTO_PARAMS.ivLengthBytes);
  });

  it('fails to decrypt with the wrong password hash', async () => {
    const hash = await getPasswordHash('pw', 'sync-id');
    const wrong = await getPasswordHash('nope', 'sync-id');
    const encrypted = await encryptData('secret', hash);
    await expect(decryptData(encrypted, wrong)).rejects.toThrow();
  });

  it('treats empty strings as empty (no-op)', async () => {
    const hash = await getPasswordHash('pw', 'sync-id');
    expect(await encryptData('', hash)).toBe('');
    expect(await decryptData('', hash)).toBe('');
  });
});
