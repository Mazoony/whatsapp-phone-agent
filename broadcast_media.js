import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const DATA_DIR = path.resolve('data');
export const BROADCAST_MEDIA_DIRECTORY = path.join(DATA_DIR, 'broadcast_media');
export const MAX_BROADCAST_MEDIA_BYTES = 300 * 1024 * 1024;
export const MAX_BROADCAST_ATTACHMENTS = 5;

const ALLOWED_MEDIA = new Map([
  ['.aac', new Set(['audio/aac', 'audio/x-aac'])],
  ['.csv', new Set(['text/csv', 'application/csv', 'application/vnd.ms-excel'])],
  ['.doc', new Set(['application/msword', 'application/vnd.ms-word'])],
  ['.docx', new Set(['application/vnd.openxmlformats-officedocument.wordprocessingml.document'])],
  ['.gif', new Set(['image/gif'])],
  ['.jpeg', new Set(['image/jpeg'])],
  ['.jpg', new Set(['image/jpeg'])],
  ['.m4a', new Set(['audio/mp4', 'audio/x-m4a'])],
  ['.mp3', new Set(['audio/mpeg', 'audio/mp3'])],
  ['.mp4', new Set(['video/mp4'])],
  ['.oga', new Set(['audio/ogg'])],
  ['.ogg', new Set(['audio/ogg'])],
  ['.opus', new Set(['audio/ogg', 'audio/opus'])],
  ['.pdf', new Set(['application/pdf'])],
  ['.png', new Set(['image/png'])],
  ['.ppt', new Set(['application/vnd.ms-powerpoint'])],
  ['.pptx', new Set(['application/vnd.openxmlformats-officedocument.presentationml.presentation'])],
  ['.text', new Set(['text/plain'])],
  ['.txt', new Set(['text/plain'])],
  ['.wav', new Set(['audio/wav', 'audio/x-wav', 'audio/wave'])],
  ['.webm', new Set(['audio/webm', 'video/webm'])],
  ['.webp', new Set(['image/webp'])],
  ['.3gp', new Set(['video/3gpp'])],
  ['.xlsx', new Set(['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'])],
  ['.xls', new Set(['application/vnd.ms-excel'])],
  ['.mov', new Set(['video/quicktime'])]
]);

function sanitizeFileName(fileName) {
  const baseName = path.basename(String(fileName || '').replace(/[\\/]/g, path.sep));
  const safeName = baseName
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[<>:"|?*]/g, '_')
    .trim()
    .slice(-180);
  if (!safeName || safeName === '.' || safeName === '..') {
    throw new Error('A valid file name is required.');
  }
  return safeName;
}

function normalizeMimeType(mimeType) {
  return String(mimeType || '').split(';', 1)[0].trim().toLowerCase();
}

export function validateBroadcastMedia({ fileName, mimeType, size, voiceNote = false }) {
  const safeName = sanitizeFileName(fileName);
  const extension = path.extname(safeName).toLowerCase();
  const normalizedMimeType = normalizeMimeType(mimeType);
  if (!ALLOWED_MEDIA.get(extension)?.has(normalizedMimeType)) {
    throw new Error('This file type is not supported for bulk messages.');
  }
  if (!Number.isInteger(size) || size < 1 || size > MAX_BROADCAST_MEDIA_BYTES) {
    throw new Error(`Attachments must be between 1 byte and ${Math.round(MAX_BROADCAST_MEDIA_BYTES / (1024 * 1024))} MB.`);
  }
  if (voiceNote && !normalizedMimeType.startsWith('audio/')) {
    throw new Error('A voice note must be an audio recording.');
  }
  return { fileName: safeName, mimeType: normalizedMimeType, size, voiceNote: Boolean(voiceNote) };
}

function mediaPaths(id, directory) {
  if (typeof id !== 'string' || !/^[0-9a-f-]{36}$/i.test(id)) {
    throw new Error('Invalid attachment identifier.');
  }
  return {
    mediaPath: path.join(directory, `${id}.bin`),
    metadataPath: path.join(directory, `${id}.json`)
  };
}

export function saveBroadcastMedia(
  buffer,
  { fileName, mimeType, voiceNote = false },
  directory = BROADCAST_MEDIA_DIRECTORY
) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    throw new Error('The attachment is empty.');
  }
  const metadata = validateBroadcastMedia({
    fileName,
    mimeType,
    size: buffer.length,
    voiceNote
  });
  const id = randomUUID();
  const { mediaPath, metadataPath } = mediaPaths(id, directory);
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(mediaPath, buffer, { flag: 'wx' });
  const attachment = { id, ...metadata, uploadedAt: new Date().toISOString() };
  try {
    fs.writeFileSync(metadataPath, JSON.stringify(attachment), { flag: 'wx' });
  } catch (error) {
    fs.rmSync(mediaPath, { force: true });
    throw error;
  }
  return attachment;
}

export function readBroadcastMedia(id, directory = BROADCAST_MEDIA_DIRECTORY) {
  const { mediaPath, metadataPath } = mediaPaths(id, directory);
  const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
  const buffer = fs.readFileSync(mediaPath);
  const validated = validateBroadcastMedia({
    fileName: metadata.fileName,
    mimeType: metadata.mimeType,
    size: buffer.length,
    voiceNote: metadata.voiceNote
  });
  return { id, ...validated, buffer };
}

export function getBroadcastMediaMetadata(id, directory = BROADCAST_MEDIA_DIRECTORY) {
  const { metadataPath } = mediaPaths(id, directory);
  const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
  const validated = validateBroadcastMedia(metadata);
  if (metadata.id !== id || metadata.size !== validated.size) {
    throw new Error('Attachment metadata is invalid.');
  }
  return { ...metadata, ...validated };
}
