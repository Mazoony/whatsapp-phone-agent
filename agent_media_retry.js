import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DATA_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'data');
export const AGENT_MEDIA_RETRY_REQUESTS_FILE = path.join(DATA_DIR, 'agent_media_retry_requests.json');
export const TELEGRAM_AGENT_MEDIA_RETRY_REQUESTS_FILE = path.join(DATA_DIR, 'telegram_agent_media_retry_requests.json');

function readRequests(filePath) {
  try {
    const requests = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (!Array.isArray(requests)) throw new Error('Media retry requests must be an array.');
    return requests;
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

function writeRequests(requests, filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(temporaryPath, JSON.stringify(requests), 'utf8');
    fs.renameSync(temporaryPath, filePath);
  } catch (error) {
    try {
      fs.rmSync(temporaryPath, { force: true });
    } catch (cleanupError) {
      console.error('[Media retry] Could not clean temporary request file:', cleanupError.message);
    }
    throw error;
  }
}

export function enqueueAgentMediaRetry(activityId, filePath = AGENT_MEDIA_RETRY_REQUESTS_FILE) {
  if (typeof activityId !== 'string' || !/^[\w-]+$/.test(activityId)) {
    throw new TypeError('A valid media activity ID is required.');
  }
  const requests = readRequests(filePath);
  if (requests.some(request => request.activityId === activityId)) {
    return { activityId, queued: false };
  }
  requests.push({ activityId, requestedAt: new Date().toISOString() });
  writeRequests(requests, filePath);
  return { activityId, queued: true };
}

export function consumeAgentMediaRetryRequests(filePath = AGENT_MEDIA_RETRY_REQUESTS_FILE) {
  const requests = readRequests(filePath);
  if (requests.length) writeRequests([], filePath);
  return requests;
}
