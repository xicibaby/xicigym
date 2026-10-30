import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { BACKUP_MAGIC, decryptBackup, encryptBackup, isEncryptedBackup, parseEncryptionKey } from '../src/infrastructure/backup-crypto.js';

const plaintext = Buffer.from('健康记录备份内容：records / revisions / idempotency；不要泄露。', 'utf8');

test('encrypt/decrypt round-trips with a 32-byte key', () => {
  const key = randomBytes(32);
  const container = encryptBackup(plaintext, { key });
  assert.equal(isEncryptedBackup(container), true);
  assert.notEqual(container.subarray(0, 16).toString('utf8'), plaintext.subarray(0, 16).toString('utf8'));
  assert.equal(decryptBackup(container, { key }).equals(plaintext), true);
});

test('encrypt/decrypt round-trips with a passphrase and random salt', () => {
  const first = encryptBackup(plaintext, { passphrase: 'correct horse battery staple' });
  const second = encryptBackup(plaintext, { passphrase: 'correct horse battery staple' });
  assert.notEqual(first.toString('base64'), second.toString('base64'), '每次加密应使用新的 salt/iv');
  assert.equal(decryptBackup(first, { passphrase: 'correct horse battery staple' }).equals(plaintext), true);
});

test('wrong key, tampered ciphertext and tampered header all fail closed', () => {
  const key = randomBytes(32);
  const container = encryptBackup(plaintext, { key });
  assert.throws(() => decryptBackup(container, { key: randomBytes(32) }), /解密失败/);
  assert.throws(() => decryptBackup(container, { passphrase: 'another passphrase entirely' }), /解密失败/);

  const tamperedCipher = Buffer.from(container);
  tamperedCipher[tamperedCipher.length - 1] ^= 0xff;
  assert.throws(() => decryptBackup(tamperedCipher, { key }), /解密失败/);

  const tamperedHeader = Buffer.from(container);
  tamperedHeader[BACKUP_MAGIC.length] ^= 0x01;
  assert.throws(() => decryptBackup(tamperedHeader, { key }), /不支持的加密备份版本/);

  const truncated = container.subarray(0, 20);
  assert.throws(() => decryptBackup(truncated, { key }), /不是受支持的加密备份文件/);
});

test('key parsing rejects missing/invalid material without echoing it', () => {
  assert.throws(() => parseEncryptionKey(''), /未设置/);
  assert.throws(() => parseEncryptionKey('not-base64!!'), /32 字节/);
  assert.throws(() => parseEncryptionKey(Buffer.from('short').toString('base64')), /32 字节/);
  const good = randomBytes(32).toString('base64');
  assert.equal(parseEncryptionKey(good).length, 32);
  assert.throws(() => decryptBackup(encryptBackup(plaintext, { passphrase: 'password-123456' }), {}), /解密失败|passphrase/);
});
