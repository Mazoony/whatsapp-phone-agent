import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { format } from 'node:util';

const DATA_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'data');
export const AGENT_LOG_FILE = path.join(DATA_DIR, 'agent.log');
export const TELEGRAM_AGENT_LOG_FILE = path.join(DATA_DIR, 'telegram_agent.log');
const MAX_LOG_BYTES = 1024 * 1024;
const LOG_RETAIN_BYTES = MAX_LOG_BYTES / 2;
const LOG_READ_BYTES = 256 * 1024;
const MAX_LOG_LINES = 500;

function trimLogFile(filePath) {
  const stats = fs.statSync(filePath);
  if (stats.size <= MAX_LOG_BYTES) return;

  const file = fs.openSync(filePath, 'r');
  let retained;
  try {
    const bytesToKeep = Math.min(LOG_RETAIN_BYTES, stats.size);
    const buffer = Buffer.alloc(bytesToKeep);
    fs.readSync(file, buffer, 0, bytesToKeep, stats.size - bytesToKeep);
    const firstLine = buffer.indexOf(0x0a);
    retained = firstLine >= 0 ? buffer.subarray(firstLine + 1) : buffer;
  } finally {
    fs.closeSync(file);
  }
  const temporaryPath = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(temporaryPath, retained);
  fs.renameSync(temporaryPath, filePath);
}

export function appendAgentLog(level, values, filePath = AGENT_LOG_FILE) {
  const timestamp = new Date().toISOString();
  const message = format(...values);
  const lines = message.split(/\r?\n/).map(line => `${timestamp} [${level}] ${line}`).join('\n');
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  if (fs.existsSync(filePath)) trimLogFile(filePath);
  fs.appendFileSync(filePath, `${lines}\n`, 'utf8');
  if (fs.statSync(filePath).size > MAX_LOG_BYTES) trimLogFile(filePath);
}

export function readRecentAgentLogs(filePath = AGENT_LOG_FILE, requestedLimit = 250) {
  const limit = Number.isInteger(requestedLimit)
    ? Math.min(MAX_LOG_LINES, Math.max(1, requestedLimit))
    : 250;

  let file;
  try {
    file = fs.openSync(filePath, 'r');
  } catch (error) {
    if (error.code === 'ENOENT') return { lines: [], updatedAt: null };
    throw error;
  }

  try {
    const stats = fs.fstatSync(file);
    const bytesToRead = Math.min(stats.size, LOG_READ_BYTES);
    const buffer = Buffer.alloc(bytesToRead);
    fs.readSync(file, buffer, 0, bytesToRead, stats.size - bytesToRead);
    const text = buffer.toString('utf8');
    const lines = text.split(/\r?\n/);
    if (stats.size > bytesToRead) lines.shift();
    if (lines.at(-1) === '') lines.pop();
    return {
      lines: lines.slice(-limit),
      updatedAt: stats.mtime.toISOString()
    };
  } finally {
    fs.closeSync(file);
  }
}

export function installAgentLogCapture(filePath = AGENT_LOG_FILE) {
  const originalError = console.error.bind(console);
  for (const level of ['log', 'info', 'warn', 'error', 'debug']) {
    const original = console[level].bind(console);
    console[level] = (...values) => {
      original(...values);
      try {
        appendAgentLog(level, values, filePath);
      } catch (error) {
        originalError('[Agent Log] Could not persist output:', error.message);
      }
    };
  }
}
