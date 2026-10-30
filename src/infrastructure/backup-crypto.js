/**
 * Backup file encryption (AES-256-GCM) for local database snapshots.
 *
 * Container format (all big-endian):
 *   magic "HSB1" (4 bytes) | version 0x01 (1 byte) | salt (16) | iv (12) | tag (16) | ciphertext
 * The first 5 bytes are used as GCM additional authenticated data, so a modified header
 * fails authentication instead of being silently ignored.
 *
 * Key sources (in order):
 *   1. `key`: 32-byte Buffer (e.g. decoded from BACKUP_ENCRYPTION_KEY, base64)
 *   2. `passphrase`: derived with scrypt(N=16384, r=8, p=1) and the random salt in the header
 *
 * This module encrypts bytes only; it never logs or persists the key/passphrase.
 */
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';

export const BACKUP_MAGIC = Buffer.from('HSB1');
export const BACKUP_VERSION = 1;
const SALT_BYTES = 16;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;
const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

function normalizeKey(key) {
  if (!Buffer.isBuffer(key) && !(key instanceof Uint8Array)) throw new TypeError('key 必须是 32 字节 Buffer');
  const buffer = Buffer.from(key);
  if (buffer.length !== KEY_BYTES) throw new TypeError('key 必须是 32 字节 Buffer');
  return buffer;
}

function deriveKey(passphrase, salt) {
  if (typeof passphrase !== 'string' || passphrase.length < 12) throw new TypeError('passphrase 至少 12 个字符');
  return scryptSync(passphrase, salt, KEY_BYTES, SCRYPT_PARAMS);
}

/** Parse BACKUP_ENCRYPTION_KEY (base64 of exactly 32 bytes). Never echo the value. */
export function parseEncryptionKey(value) {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError('BACKUP_ENCRYPTION_KEY 未设置');
  let decoded;
  try { decoded = Buffer.from(value.trim(), 'base64'); } catch { throw new TypeError('BACKUP_ENCRYPTION_KEY 不是合法 base64'); }
  if (decoded.length !== KEY_BYTES) throw new TypeError('BACKUP_ENCRYPTION_KEY 解码后必须是 32 字节');
  return decoded;
}

export function isEncryptedBackup(data) {
  const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
  return buffer.length >= BACKUP_MAGIC.length + 1 && buffer.subarray(0, BACKUP_MAGIC.length).equals(BACKUP_MAGIC);
}

/**
 * @param {Buffer|Uint8Array} data plaintext bytes
 * @param {{key?: Buffer, passphrase?: string}} options exactly one key source
 * @returns {Buffer} encrypted container
 */
export function encryptBackup(data, { key, passphrase } = {}) {
  const plaintext = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const salt = randomBytes(SALT_BYTES);
  const iv = randomBytes(IV_BYTES);
  const actualKey = key ? normalizeKey(key) : deriveKey(passphrase, salt);
  const header = Buffer.alloc(BACKUP_MAGIC.length + 1);
  BACKUP_MAGIC.copy(header, 0);
  header[BACKUP_MAGIC.length] = BACKUP_VERSION;
  const cipher = createCipheriv('aes-256-gcm', actualKey, iv);
  cipher.setAAD(header);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([header, salt, iv, tag, ciphertext]);
}

/**
 * @param {Buffer|Uint8Array} container encrypted bytes produced by encryptBackup
 * @param {{key?: Buffer, passphrase?: string}} options matching key source used at encryption
 * @returns {Buffer} plaintext bytes
 */
export function decryptBackup(container, { key, passphrase } = {}) {
  const buffer = Buffer.isBuffer(container) ? container : Buffer.from(container);
  const minimum = BACKUP_MAGIC.length + 1 + SALT_BYTES + IV_BYTES + TAG_BYTES;
  if (buffer.length < minimum || !isEncryptedBackup(buffer)) throw new Error('不是受支持的加密备份文件');
  if (buffer[BACKUP_MAGIC.length] !== BACKUP_VERSION) throw new Error(`不支持的加密备份版本：${buffer[BACKUP_MAGIC.length]}`);
  const header = buffer.subarray(0, BACKUP_MAGIC.length + 1);
  const saltStart = header.length;
  const ivStart = saltStart + SALT_BYTES;
  const tagStart = ivStart + IV_BYTES;
  const cipherStart = tagStart + TAG_BYTES;
  const salt = buffer.subarray(saltStart, ivStart);
  const iv = buffer.subarray(ivStart, tagStart);
  const tag = buffer.subarray(tagStart, cipherStart);
  const ciphertext = buffer.subarray(cipherStart);
  const actualKey = key ? normalizeKey(key) : deriveKey(passphrase, salt);
  const decipher = createDecipheriv('aes-256-gcm', actualKey, iv);
  decipher.setAAD(header);
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch {
    // Never leak ciphertext or key material in the error text.
    throw new Error('备份解密失败：密钥错误或文件已被篡改');
  }
}
