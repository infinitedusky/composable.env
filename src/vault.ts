import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as age from 'age-encryption';
import { isCenvEncrypted } from './markers.js';

const CENV_ENC_PREFIX = 'CENV_ENC[';
const CENV_ENC_SUFFIX = ']';
const CENV_ENC_REGEX = /^CENV_ENC\[(.+)\]$/;

interface RecipientEntry {
  /** The original key as stored in .recipients (SSH or age format) */
  original: string;
  /** The age1... recipient string for use with typage Encrypter */
  ageRecipient: string;
  /** User-friendly comment */
  comment: string;
}

export class Vault {
  private configDir: string;
  private recipientsPath: string;
  private sharedPath: string;

  constructor(configDir: string) {
    this.configDir = configDir;
    this.recipientsPath = path.join(configDir, 'env', '.recipients');
    // Use .env.secrets.shared if it exists, fall back to .env.shared for legacy
    const secretsPath = path.join(configDir, 'env', '.env.secrets.shared');
    const legacyPath = path.join(configDir, 'env', '.env.shared');
    this.sharedPath = fs.existsSync(secretsPath) ? secretsPath : legacyPath;
  }

  hasVault(): boolean {
    return fs.existsSync(this.recipientsPath);
  }

  // ─── Encryption ─────────────────────────────────────────────────────────────

  async encrypt(value: string): Promise<string> {
    const recipients = await this.loadRecipients();
    if (recipients.length === 0) {
      throw new Error('No recipients found in .recipients file. Run `ce vault init` first.');
    }

    const e = new age.Encrypter();
    for (const r of recipients) {
      e.addRecipient(r.ageRecipient);
    }

    const ciphertext = await e.encrypt(value);
    const armored = age.armor.encode(ciphertext);
    const base64 = Buffer.from(armored).toString('base64');
    return `${CENV_ENC_PREFIX}${base64}${CENV_ENC_SUFFIX}`;
  }

  async decrypt(encrypted: string): Promise<string> {
    const match = encrypted.match(CENV_ENC_REGEX);
    if (!match) throw new Error('Not a CENV_ENC value');

    const armored = Buffer.from(match[1], 'base64').toString();
    const ciphertext = age.armor.decode(armored);

    const d = new age.Decrypter();
    const identity = await this.loadIdentity();
    d.addIdentity(identity);

    return await d.decrypt(ciphertext, 'text');
  }

  async decryptPool(pool: Record<string, string>): Promise<void> {
    const encryptedKeys = Object.entries(pool).filter(([, v]) => isCenvEncrypted(v));
    if (encryptedKeys.length === 0) return;

    for (const [key, value] of encryptedKeys) {
      pool[key] = await this.decrypt(value);
    }
  }

  // ─── Secret management ──────────────────────────────────────────────────────

  async setSecret(key: string, value: string): Promise<void> {
    const encrypted = await this.encrypt(value);
    const lines = this.readSharedLines();
    let found = false;

    for (let i = 0; i < lines.length; i++) {
      const trimmed = lines[i].trim();
      if (trimmed.startsWith(`${key}=`)) {
        lines[i] = `${key}=${encrypted}`;
        found = true;
        break;
      }
    }

    if (!found) {
      lines.push(`${key}=${encrypted}`);
    }

    fs.writeFileSync(this.sharedPath, lines.join('\n') + '\n');
  }

  async getSecret(key: string): Promise<string | null> {
    const lines = this.readSharedLines();
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith(`${key}=`)) {
        const value = trimmed.slice(key.length + 1);
        if (isCenvEncrypted(value)) {
          return this.decrypt(value);
        }
        return value;
      }
    }
    return null;
  }

  listSecrets(): string[] {
    const lines = this.readSharedLines();
    const secrets: string[] = [];

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;

      const eqIdx = trimmed.indexOf('=');
      if (eqIdx === -1) continue;

      const value = trimmed.slice(eqIdx + 1);
      if (isCenvEncrypted(value)) {
        secrets.push(trimmed.slice(0, eqIdx));
      }
    }

    return secrets;
  }

  // ─── Recipient management ───────────────────────────────────────────────────

  async init(): Promise<{ created: boolean; identity?: string; publicKey?: string }> {
    const envDir = path.join(this.configDir, 'env');
    if (!fs.existsSync(envDir)) {
      fs.mkdirSync(envDir, { recursive: true });
    }

    const created = !fs.existsSync(this.recipientsPath);
    if (created) {
      fs.writeFileSync(
        this.recipientsPath,
        '# composable.env vault recipients\n' +
          '# Each line: public key [# optional comment]\n' +
          '#\n' +
          '# Supported key types:\n' +
          '#   age1...             (native age public key)\n' +
          '#   ssh-ed25519 AAAA... (SSH ed25519 — auto-converted to age)\n' +
          '#\n'
      );
    }

    // Try to find an existing identity and add its public key
    const identityPath = this.getIdentityFilePath();

    if (fs.existsSync(identityPath)) {
      const identityContent = fs.readFileSync(identityPath, 'utf8').trim();
      const secretKey = identityContent
        .split('\n')
        .find(l => l.startsWith('AGE-SECRET-KEY-'));
      if (secretKey) {
        const publicKey = await age.identityToRecipient(secretKey);
        await this.addRecipient(publicKey, 'local age identity');
        return { created, identity: identityPath, publicKey };
      }
    }

    // Try SSH ed25519 — convert private key to age identity, derive recipient
    const sshEd25519Private = path.join(os.homedir(), '.ssh', 'id_ed25519');
    if (fs.existsSync(sshEd25519Private)) {
      const { sshKeyFileToAge } = await import('sops-age');
      const ageSecretKey = await sshKeyFileToAge(sshEd25519Private);
      if (ageSecretKey) {
        const publicKey = await age.identityToRecipient(ageSecretKey);
        await this.addRecipient(publicKey, 'local SSH key (ed25519)');
        return { created, publicKey };
      }
    }

    // No existing key — generate a new age identity
    const identity = await age.generateIdentity();
    const publicKey = await age.identityToRecipient(identity);

    const identityDir = path.dirname(identityPath);
    if (!fs.existsSync(identityDir)) {
      fs.mkdirSync(identityDir, { recursive: true });
    }

    fs.writeFileSync(
      identityPath,
      `# created: ${new Date().toISOString()}\n` +
        `# public key: ${publicKey}\n` +
        `${identity}\n`,
      { mode: 0o600 }
    );

    await this.addRecipient(publicKey, 'generated age key');
    return { created, identity: identityPath, publicKey };
  }

  async addRecipient(publicKey: string, comment?: string): Promise<void> {
    // Convert SSH keys to age recipients for storage
    const ageKey = await sshPublicKeyToAge(publicKey);
    const keyToStore = ageKey ?? publicKey;

    const recipients = await this.loadRecipients();
    if (recipients.some(r => r.ageRecipient === keyToStore)) {
      return; // Already exists
    }

    const line = comment ? `${keyToStore} # ${comment}` : keyToStore;
    fs.appendFileSync(this.recipientsPath, line + '\n');

    // Re-encrypt all existing secrets with updated recipient list
    await this.reEncryptAll();
  }

  async addGitHubRecipient(username: string): Promise<string[]> {
    const url = `https://github.com/${username}.keys`;
    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(`Failed to fetch SSH keys for GitHub user '${username}': ${res.statusText}`);
    }

    const text = await res.text();
    const keys = text
      .trim()
      .split('\n')
      .filter(k => k.startsWith('ssh-ed25519'));

    if (keys.length === 0) {
      throw new Error(
        `No ed25519 SSH keys found for GitHub user: ${username}. ` +
          `Only ed25519 keys can be converted to age recipients.`
      );
    }

    const added: string[] = [];
    for (const sshKey of keys) {
      const ageKey = await sshPublicKeyToAge(sshKey);
      if (!ageKey) continue;

      const recipients = await this.loadRecipients();
      if (recipients.some(r => r.ageRecipient === ageKey)) continue;

      const line = `${ageKey} # GitHub: ${username}`;
      fs.appendFileSync(this.recipientsPath, line + '\n');
      added.push(ageKey);
    }

    if (added.length > 0) {
      await this.reEncryptAll();
    }

    return added;
  }

  async removeRecipient(identifier: string): Promise<boolean> {
    const lines = fs.readFileSync(this.recipientsPath, 'utf8').split('\n');
    const newLines: string[] = [];
    let removed = false;

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) {
        newLines.push(line);
        continue;
      }

      if (trimmed.includes(identifier)) {
        removed = true;
        continue;
      }

      newLines.push(line);
    }

    if (removed) {
      fs.writeFileSync(this.recipientsPath, newLines.join('\n'));
      await this.reEncryptAll();
    }

    return removed;
  }

  listRecipients(): { key: string; comment: string }[] {
    return this.loadRecipientsSync();
  }

  // ─── Private helpers ────────────────────────────────────────────────────────

  private async loadRecipients(): Promise<RecipientEntry[]> {
    return this.loadRecipientsSync().map(r => ({
      original: r.key,
      ageRecipient: r.key, // All keys are stored as age1... format now
      comment: r.comment,
    }));
  }

  private loadRecipientsSync(): { key: string; comment: string }[] {
    if (!fs.existsSync(this.recipientsPath)) return [];

    const lines = fs.readFileSync(this.recipientsPath, 'utf8').split('\n');
    const recipients: { key: string; comment: string }[] = [];

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;

      if (trimmed.startsWith('age1')) {
        const commentIdx = trimmed.indexOf(' # ');
        if (commentIdx !== -1) {
          recipients.push({
            key: trimmed.slice(0, commentIdx),
            comment: trimmed.slice(commentIdx + 3),
          });
        } else {
          recipients.push({ key: trimmed, comment: '' });
        }
      }
    }

    return recipients;
  }

  private async loadIdentity(): Promise<string> {
    // 1. CE_AGE_KEY env var (raw age secret key), with CENV_AGE_KEY fallback
    const ageKey = process.env.CE_AGE_KEY || process.env.CENV_AGE_KEY;
    if (ageKey) {
      return ageKey;
    }

    // 2. Age identity file
    const identityPath = this.getIdentityFilePath();
    if (fs.existsSync(identityPath)) {
      const content = fs.readFileSync(identityPath, 'utf8');
      const secretKey = content
        .split('\n')
        .find(l => l.startsWith('AGE-SECRET-KEY-'));
      if (secretKey) return secretKey;
    }

    // 3. SSH private key → convert to age identity via sops-age
    const sshEd25519 = path.join(os.homedir(), '.ssh', 'id_ed25519');
    const sshRsa = path.join(os.homedir(), '.ssh', 'id_rsa');

    const sshPath = fs.existsSync(sshEd25519)
      ? sshEd25519
      : fs.existsSync(sshRsa)
        ? sshRsa
        : null;

    if (sshPath) {
      const { sshKeyFileToAge } = await import('sops-age');
      const ageKey = await sshKeyFileToAge(sshPath);
      if (ageKey) return ageKey;
    }

    throw new Error(
      'No age identity found. Set CE_AGE_KEY env var, create an identity ' +
        'at ~/.config/composable.env/identity, or ensure ~/.ssh/id_ed25519 exists.'
    );
  }

  private getIdentityFilePath(): string {
    return path.join(os.homedir(), '.config', 'composable.env', 'identity');
  }

  private readSharedLines(): string[] {
    if (!fs.existsSync(this.sharedPath)) return [];
    return fs.readFileSync(this.sharedPath, 'utf8').split('\n');
  }

  private async reEncryptAll(): Promise<void> {
    const lines = this.readSharedLines();
    let changed = false;

    const decrypted: { index: number; key: string; plaintext: string }[] = [];

    for (let i = 0; i < lines.length; i++) {
      const trimmed = lines[i].trim();
      if (!trimmed || trimmed.startsWith('#')) continue;

      const eqIdx = trimmed.indexOf('=');
      if (eqIdx === -1) continue;

      const key = trimmed.slice(0, eqIdx);
      const value = trimmed.slice(eqIdx + 1);

      if (isCenvEncrypted(value)) {
        try {
          const plaintext = await this.decrypt(value);
          decrypted.push({ index: i, key, plaintext });
        } catch {
          continue;
        }
      }
    }

    for (const { index, key, plaintext } of decrypted) {
      const newEncrypted = await this.encrypt(plaintext);
      lines[index] = `${key}=${newEncrypted}`;
      changed = true;
    }

    if (changed) {
      fs.writeFileSync(this.sharedPath, lines.join('\n'));
    }
  }
}

// ─── Utilities ────────────────────────────────────────────────────────────────

// Re-export for convenience (defined in markers.ts to avoid pulling in crypto deps)
export { isCenvEncrypted } from './markers.js';

/**
 * Convert an SSH ed25519 public key to an age recipient (age1...).
 * Returns null if the key is not an ed25519 SSH key.
 *
 * The conversion extracts the raw ed25519 public key bytes from the SSH
 * wire format, converts from Edwards to Montgomery form (X25519),
 * then bech32-encodes with the "age" HRP.
 */
async function sshPublicKeyToAge(publicKey: string): Promise<string | null> {
  if (!publicKey.startsWith('ssh-ed25519 ')) return null;

  const parts = publicKey.trim().split(/\s+/);
  if (parts.length < 2) return null;

  const keyData = Buffer.from(parts[1], 'base64');

  // SSH wire format: [4-byte length][key-type string][4-byte length][key data]
  // For ed25519: key-type = "ssh-ed25519", key data = 32 bytes
  let offset = 0;
  const typeLen = keyData.readUInt32BE(offset);
  offset += 4 + typeLen; // skip type
  const dataLen = keyData.readUInt32BE(offset);
  offset += 4;

  if (dataLen !== 32) return null;

  const ed25519Pub = keyData.subarray(offset, offset + 32);

  // Convert Edwards curve point → Montgomery curve point (ed25519 → X25519)
  const { edwardsToMontgomeryPub } = await import('@noble/curves/ed25519');
  const x25519Pub: Uint8Array = edwardsToMontgomeryPub(ed25519Pub);

  // Bech32 encode with "age" HRP
  const { bech32 } = await import('@scure/base');
  const words = bech32.toWords(x25519Pub);
  return bech32.encode('age', words);
}
