import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const DATA_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'data');
const require = createRequire(import.meta.url);
const QRCode = require('qrcode-terminal/vendor/QRCode');
const QRErrorCorrectLevel = require('qrcode-terminal/vendor/QRCode/QRErrorCorrectLevel');
export const AGENT_STATUS_FILE = path.join(DATA_DIR, 'agent_status.json');
export const AGENT_QR_FILE = path.join(DATA_DIR, 'agent_qr.json');
const AGENT_QR_MAX_AGE_MS = 60_000;

export function readLastConnectedAt(filePath = AGENT_STATUS_FILE) {
  const value = readStoredAgentStatus(filePath)?.lastConnectedAt;
  return typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : null;
}

export function readLastAgentAccount(filePath = AGENT_STATUS_FILE) {
  const account = readStoredAgentStatus(filePath)?.account;
  if (!account || typeof account !== 'object' ||
      typeof account.phoneNumber !== 'string' || !/^\d+$/.test(account.phoneNumber)) {
    return null;
  }
  return {
    name: typeof account.name === 'string' ? account.name : '',
    phoneNumber: account.phoneNumber
  };
}

function readStoredAgentStatus(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

export function writeAgentStatus(
  connectionState,
  lastConnectedAt = null,
  account = null,
  filePath = AGENT_STATUS_FILE
) {
  const status = {
    connectionState,
    lastConnectedAt,
    account,
    updatedAt: new Date().toISOString()
  };
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(temporaryPath, JSON.stringify(status, null, 2), 'utf8');
  fs.renameSync(temporaryPath, filePath);
  return status;
}

export function writeAgentQr(value, filePath = AGENT_QR_FILE) {
  if (typeof value !== 'string' || !value) {
    throw new Error('WhatsApp pairing QR data must be a non-empty string.');
  }
  const qr = { value, updatedAt: new Date().toISOString() };
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(temporaryPath, JSON.stringify(qr), 'utf8');
  fs.renameSync(temporaryPath, filePath);
  return qr;
}

export function readAgentQr(filePath = AGENT_QR_FILE, now = Date.now()) {
  const qr = readStoredAgentStatus(filePath);
  if (!qr || typeof qr.value !== 'string' || !qr.value) return null;
  const updatedAtMs = Date.parse(qr.updatedAt || '');
  if (!Number.isFinite(updatedAtMs) || now - updatedAtMs < 0 ||
      now - updatedAtMs > AGENT_QR_MAX_AGE_MS) return null;
  return qr;
}

export function clearAgentQr(filePath = AGENT_QR_FILE) {
  try {
    fs.unlinkSync(filePath);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

export function renderAgentQrSvg(value) {
  if (typeof value !== 'string' || !value) {
    throw new Error('WhatsApp pairing QR data must be a non-empty string.');
  }
  const code = new QRCode(-1, QRErrorCorrectLevel.L);
  code.addData(value);
  code.make();

  const quietZone = 4;
  const size = code.getModuleCount() + quietZone * 2;
  let pathData = '';
  for (let row = 0; row < code.getModuleCount(); row += 1) {
    for (let column = 0; column < code.getModuleCount(); column += 1) {
      if (code.isDark(row, column)) {
        pathData += `M${column + quietZone},${row + quietZone}h1v1h-1z`;
      }
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges"><rect width="${size}" height="${size}" fill="#fff"/><path d="${pathData}" fill="#000"/></svg>`;
}
