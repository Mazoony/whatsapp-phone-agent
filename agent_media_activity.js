import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const DATA_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'data');
export const AGENT_MEDIA_ACTIVITY_FILE = path.join(DATA_DIR, 'agent_media_activity.json');
export const TELEGRAM_AGENT_MEDIA_ACTIVITY_FILE = path.join(DATA_DIR, 'telegram_agent_media_activity.json');
const MAX_ACTIVITIES = 20;
const RENAME_RETRY_DELAYS_MS = [10, 25, 50, 100];

function readStoredActivities(filePath) {
  try {
    const stored = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (!stored || !Array.isArray(stored.activities)) {
      throw new Error('Invalid media activity data.');
    }
    return stored.activities;
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

export function writeAgentMediaActivity(activity, filePath = AGENT_MEDIA_ACTIVITY_FILE) {
  const activities = readStoredActivities(filePath);
  const index = activities.findIndex(item => item.id === activity.id);
  if (index >= 0) activities[index] = activity;
  else activities.unshift(activity);

  const stored = {
    activities: activities
      .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt))
      .slice(0, MAX_ACTIVITIES)
  };
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporaryPath, JSON.stringify(stored, null, 2), 'utf8');
    for (let attempt = 0; ; attempt += 1) {
      try {
        fs.renameSync(temporaryPath, filePath);
        break;
      } catch (error) {
        if (!['EPERM', 'EBUSY'].includes(error.code) ||
            attempt >= RENAME_RETRY_DELAYS_MS.length) {
          throw error;
        }
        Atomics.wait(
          new Int32Array(new SharedArrayBuffer(4)),
          0,
          0,
          RENAME_RETRY_DELAYS_MS[attempt]
        );
      }
    }
  } catch (error) {
    try {
      fs.rmSync(temporaryPath, { force: true });
    } catch (cleanupError) {
      console.error('[Agent Media Activity] Could not clean temporary file:', cleanupError.message);
    }
    throw error;
  }
  return stored.activities;
}

export function readAgentMediaActivities(filePath = AGENT_MEDIA_ACTIVITY_FILE) {
  return readStoredActivities(filePath).slice(0, MAX_ACTIVITIES);
}
