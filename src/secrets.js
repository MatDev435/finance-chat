import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';

const FORMAT = 'v1';
const IV_BYTES = 12;
const TAG_BYTES = 16;

/** Derives an independent 32-byte key for one purpose from APP_SECRET (HKDF-SHA256). */
export function deriveKey(appSecret, purpose) {
  return Buffer.from(hkdfSync('sha256', Buffer.from(appSecret, 'utf8'), Buffer.from('finance-chat'), Buffer.from(purpose, 'utf8'), 32));
}

function invalid() {
  const error = new Error('Não foi possível ler uma credencial protegida. A APP_SECRET pode ter mudado.');
  error.code = 'SECRET_UNREADABLE';
  return error;
}

/**
 * AES-256-GCM encryption for credentials stored in SQLite. `context` is bound
 * as additional authenticated data, so a value copied to another user or
 * field fails to decrypt instead of being silently accepted. `purpose` selects
 * an independent key derived from APP_SECRET (one box per kind of secret: the
 * Actual credentials and the OpenAI API keys never share a key).
 */
export function createSecretBox(appSecret, purpose = 'actual-credentials-v1') {
  const key = deriveKey(appSecret, purpose);

  return {
    seal(plaintext, context) {
      const iv = randomBytes(IV_BYTES);
      const cipher = createCipheriv('aes-256-gcm', key, iv, { authTagLength: TAG_BYTES });
      cipher.setAAD(Buffer.from(context, 'utf8'));
      const ciphertext = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
      return [FORMAT, iv.toString('base64url'), ciphertext.toString('base64url'), cipher.getAuthTag().toString('base64url')].join('.');
    },

    open(sealed, context) {
      const parts = typeof sealed === 'string' ? sealed.split('.') : [];
      if (parts.length !== 4 || parts[0] !== FORMAT) throw invalid();
      try {
        const [, iv, ciphertext, tag] = parts.map((part, index) => (index === 0 ? part : Buffer.from(part, 'base64url')));
        if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) throw invalid();
        const decipher = createDecipheriv('aes-256-gcm', key, iv, { authTagLength: TAG_BYTES });
        decipher.setAAD(Buffer.from(context, 'utf8'));
        decipher.setAuthTag(tag);
        return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
      } catch {
        throw invalid();
      }
    },
  };
}
