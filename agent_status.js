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
export const AGENT_CONTROL_FILE = path.join(DATA_DIR, 'agent_control.json');
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
  filePath = AGENT_STATUS_FILE,
  respondingEnabled = true,
  queuePaused = false
) {
  const status = {
    connectionState,
    lastConnectedAt,
    account,
    respondingEnabled,
    queuePaused,
    processId: process.pid,
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

export function requestAgentDisconnect(filePath = AGENT_CONTROL_FILE) {
  return writeAgentControlRequest('disconnect', filePath);
}

export function requestAgentResponseMode(respondingEnabled, filePath = AGENT_CONTROL_FILE) {
  if (typeof respondingEnabled !== 'boolean') {
    throw new TypeError('Agent response mode must be a boolean.');
  }
  return writeAgentControlRequest(respondingEnabled ? 'resume_replies' : 'pause_replies', filePath);
}

export function requestAgentQueueMode(paused, filePath = AGENT_CONTROL_FILE) {
  if (typeof paused !== 'boolean') {
    throw new TypeError('Agent queue pause mode must be a boolean.');
  }
  return writeAgentControlRequest(paused ? 'pause_queue' : 'resume_queue', filePath);
}

export function requestAgentQueueCancellation(jid, filePath = AGENT_CONTROL_FILE) {
  if (typeof jid !== 'string' || !/^\d+@(s\.whatsapp\.net|lid)$/.test(jid)) {
    throw new TypeError('A valid direct chat ID is required to cancel queued handling.');
  }
  return writeAgentControlRequest('cancel_queued_chat', filePath, { jid });
}

function writeAgentControlRequest(action, filePath, details = {}) {
  const request = { action, ...details, requestedAt: new Date().toISOString() };
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(temporaryPath, JSON.stringify(request), 'utf8');
  fs.renameSync(temporaryPath, filePath);
  return request;
}

export function consumeAgentControlRequest(filePath = AGENT_CONTROL_FILE) {
  let request;
  try {
    request = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
  if (!request || ![
    'disconnect',
    'pause_replies',
    'resume_replies',
    'pause_queue',
    'resume_queue',
    'cancel_queued_chat'
  ].includes(request.action) ||
      typeof request.requestedAt !== 'string' ||
      !Number.isFinite(Date.parse(request.requestedAt))) {
    throw new Error('Agent control request is invalid.');
  }
  if (request.action === 'cancel_queued_chat') {
    if (typeof request.jid !== 'string' || !/^\d+@(s\.whatsapp\.net|lid)$/.test(request.jid)) {
      throw new Error('Agent queue cancellation request is invalid.');
    }
    fs.unlinkSync(filePath);
    return { action: request.action, jid: request.jid };
  }
  fs.unlinkSync(filePath);
  return request.action;
}

export function consumeAgentDisconnectRequest(filePath = AGENT_CONTROL_FILE) {
  return consumeAgentControlRequest(filePath) === 'disconnect';
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
