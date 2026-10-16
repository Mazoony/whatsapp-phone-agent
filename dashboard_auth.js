import fs from 'node:fs';
import path from 'node:path';
import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCallback);
const SESSION_COOKIE = 'eshool_dashboard_session';
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const LOGIN_WINDOW_MS = 5 * 60 * 1000;
const LOGIN_FAILURE_LIMIT = 5;
const LOCKOUT_MS = 5 * 60 * 1000;
const SCRYPT_OPTIONS = { N: 16_384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const PASSWORD_HASH_BYTES = 64;

function sessionTokenFromRequest(req) {
  const cookieHeader = req.headers.cookie || '';
  for (const part of cookieHeader.split(';')) {
    const separator = part.indexOf('=');
    if (separator < 0 || part.slice(0, separator).trim() !== SESSION_COOKIE) continue;
    try {
      return decodeURIComponent(part.slice(separator + 1).trim());
    } catch {
      return '';
    }
  }
  return '';
}

function setSessionCookie(res, token, maxAge = SESSION_TTL_MS / 1000) {
  res.setHeader('Set-Cookie',
    `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}`);
}

function clearSessionCookie(res) {
  setSessionCookie(res, '', 0);
}

async function derivePasswordHash(password, salt) {
  return scrypt(password, salt, PASSWORD_HASH_BYTES, SCRYPT_OPTIONS);
}

export class DashboardAuth {
  constructor(authFile) {
    this.authFile = authFile;
    this.sessions = new Map();
    this.loginAttempts = new Map();
  }

  isConfigured() {
    return fs.existsSync(this.authFile);
  }

  status(req) {
    return {
      setupRequired: !this.isConfigured(),
      authenticated: this.isAuthenticated(req)
    };
  }

  isAuthenticated(req) {
    const token = sessionTokenFromRequest(req);
    const expiresAt = this.sessions.get(token);
    if (!expiresAt) return false;
    if (expiresAt <= Date.now()) {
      this.sessions.delete(token);
      return false;
    }
    return true;
  }

  async setup(password) {
    if (this.isConfigured()) {
      return { ok: false, status: 409, error: 'Dashboard password is already configured.' };
    }
    if (typeof password !== 'string' || password.length < 12 || password.length > 1024) {
      return { ok: false, status: 400, error: 'Choose a password between 12 and 1,024 characters.' };
    }

    const salt = randomBytes(16);
    const hash = await derivePasswordHash(password, salt);
    const record = JSON.stringify({
      version: 1,
      algorithm: 'scrypt',
      salt: salt.toString('hex'),
      hash: hash.toString('hex')
    });
    fs.mkdirSync(path.dirname(this.authFile), { recursive: true });
    let fileDescriptor;
    try {
      fileDescriptor = fs.openSync(this.authFile, 'wx', 0o600);
      fs.writeFileSync(fileDescriptor, record, 'utf8');
      fs.fsyncSync(fileDescriptor);
    } catch (error) {
      if (error.code === 'EEXIST') {
        return { ok: false, status: 409, error: 'Dashboard password is already configured.' };
      }
      throw error;
    } finally {
      if (fileDescriptor !== undefined) fs.closeSync(fileDescriptor);
    }
    return { ok: true };
  }

  async login(req, password) {
    const now = Date.now();
    const key = req.socket.remoteAddress || 'local';
    const attempts = this.loginAttempts.get(key) || { failures: 0, windowStartedAt: now, lockedUntil: 0 };
    if (attempts.lockedUntil > now) {
      return {
        ok: false,
        status: 429,
        retryAfter: Math.ceil((attempts.lockedUntil - now) / 1000),
        error: 'Too many incorrect attempts. Wait before trying again.'
      };
    }

    if (now - attempts.windowStartedAt >= LOGIN_WINDOW_MS) {
      attempts.failures = 0;
      attempts.windowStartedAt = now;
    }
    const credential = this.readCredential();
    let matches = false;
    if (typeof password === 'string' && password.length <= 1024) {
      const suppliedHash = await derivePasswordHash(password, Buffer.from(credential.salt, 'hex'));
      const storedHash = Buffer.from(credential.hash, 'hex');
      matches = storedHash.length === suppliedHash.length &&
        timingSafeEqual(storedHash, suppliedHash);
    }

    if (!matches) {
      attempts.failures += 1;
      if (attempts.failures >= LOGIN_FAILURE_LIMIT) {
        attempts.lockedUntil = now + LOCKOUT_MS;
      }
      this.loginAttempts.set(key, attempts);
      return {
        ok: false,
        status: attempts.lockedUntil > now ? 429 : 401,
        ...(attempts.lockedUntil > now ? { retryAfter: Math.ceil(LOCKOUT_MS / 1000) } : {}),
        error: attempts.lockedUntil > now
          ? 'Too many incorrect attempts. Wait before trying again.'
          : 'Incorrect password.'
      };
    }

    this.loginAttempts.delete(key);
    const token = randomBytes(32).toString('base64url');
    this.sessions.set(token, now + SESSION_TTL_MS);
    return { ok: true, token, maxAge: SESSION_TTL_MS / 1000 };
  }

  logout(req) {
    const token = sessionTokenFromRequest(req);
    this.sessions.delete(token);
  }

  setCookie(res, token, maxAge) {
    setSessionCookie(res, token, maxAge);
  }

  clearCookie(res) {
    clearSessionCookie(res);
  }

  readCredential() {
    const record = JSON.parse(fs.readFileSync(this.authFile, 'utf8'));
    if (record.version !== 1 ||
        record.algorithm !== 'scrypt' ||
        !/^[0-9a-f]{32}$/i.test(record.salt) ||
        !/^[0-9a-f]{128}$/i.test(record.hash)) {
      throw new Error('Dashboard password file is invalid.');
    }
    return record;
  }
}
