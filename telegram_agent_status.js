import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT_DIR = path.dirname(fileURLToPath(import.meta.url));
export const TELEGRAM_AGENT_STATUS_FILE = path.join(ROOT_DIR, 'data', 'telegram_agent_status.json');

export function readTelegramAgentStatus(filePath = TELEGRAM_AGENT_STATUS_FILE) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

export function writeTelegramAgentStatus(
  connectionState,
  {
    filePath = TELEGRAM_AGENT_STATUS_FILE,
    botUsername,
    lastConnectedAt,
    logger = console
  } = {}
) {
  if (!['connecting', 'connected', 'retrying', 'disconnected'].includes(connectionState)) {
    throw new Error('Telegram agent connection state is invalid.');
  }
  let previous;
  try {
    previous = readTelegramAgentStatus(filePath);
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    logger.warn('[Telegram Status] Existing status file is invalid JSON; replacing it with a fresh status.');
    previous = null;
  }
  const connectedAt = lastConnectedAt === undefined
    ? previous?.lastConnectedAt || null
    : lastConnectedAt;
  const username = botUsername === undefined
    ? previous?.botUsername || ''
    : botUsername;
  const status = {
    connectionState,
    botUsername: typeof username === 'string' ? username : '',
    lastConnectedAt: connectedAt,
    processId: process.pid,
    updatedAt: new Date().toISOString()
  };
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(temporaryPath, JSON.stringify(status, null, 2), 'utf8');
    fs.renameSync(temporaryPath, filePath);
  } catch (error) {
    try {
      fs.rmSync(temporaryPath, { force: true });
    } catch (cleanupError) {
      console.error('[Telegram Status] Could not clean temporary status file:', cleanupError.message);
    }
    throw error;
  }
  return status;
}
