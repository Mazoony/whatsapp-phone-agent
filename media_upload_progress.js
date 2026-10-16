import { writeAgentMediaActivity } from './agent_media_activity.js';

const MEDIA_LABELS = {
  image: 'Image',
  video: 'Video',
  audio: 'Audio',
  document: 'Document',
  sticker: 'Sticker'
};
const BAR_WIDTH = 24;

function mediaByteLength(content, mediaType) {
  const media = content[mediaType];
  if (Buffer.isBuffer(media) || media instanceof Uint8Array) return media.byteLength;
  return null;
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return 'unknown size';
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function createMediaUploadProgress({
  isTTY = () => Boolean(process.stdout.isTTY),
  write = chunk => process.stdout.write(chunk),
  log = message => console.log(message),
  onActivity = writeAgentMediaActivity
} = {}) {
  let activeUpload = null;
  let uploadQueue = Promise.resolve();
  const wrappedSockets = new WeakSet();
  let nextActivityId = 0;

  function persistActivity(activity) {
    try {
      onActivity({ ...activity });
    } catch (error) {
      console.error('[Media upload] Could not update dashboard activity:', error.message);
    }
  }

  function render(event = {}) {
    if (!activeUpload || !isTTY()) return;
    const total = Number(event.total) > 0 ? Number(event.total) : activeUpload.fileSize;
    const loaded = Math.max(0, Number(event.loaded) || 0);
    const ratio = total > 0 ? Math.min(loaded / total, 1) : 0;
    const percent = Math.floor(ratio * 100);
    const filled = Math.floor(ratio * BAR_WIDTH);
    const bar = `${'='.repeat(filled)}${' '.repeat(BAR_WIDTH - filled)}`;
    const totalLabel = Number(event.total) > 0 ? formatBytes(total) : formatBytes(activeUpload.fileSize);

    write(`\r[${activeUpload.label} upload] ${percent.toString().padStart(3)}% [${bar}] ${formatBytes(loaded)} / ${totalLabel}`);
  }

  function finish(success) {
    if (!activeUpload) return;
    const { fileSize, label, activity } = activeUpload;
    activity.status = success ? 'sent' : 'failed';
    activity.loaded = success && Number.isFinite(fileSize) ? fileSize : activity.loaded;
    activity.total = fileSize;
    activity.percent = success ? 100 : activity.percent;
    activity.updatedAt = new Date().toISOString();
    persistActivity(activity);
    if (isTTY()) {
      if (success) render({ loaded: fileSize, total: fileSize });
      write(`\r[${label} upload] ${success ? 'Complete' : 'Failed'}: ${formatBytes(fileSize)}${' '.repeat(48)}\n`);
    } else {
      log(`[Media upload] ${label} upload ${success ? 'complete' : 'failed'} (${formatBytes(fileSize)}).`);
    }
    activeUpload = null;
  }

  function report(event) {
    if (!activeUpload) return;
    const loaded = Math.max(0, Number(event.loaded) || 0);
    const total = Number(event.total) > 0 ? Number(event.total) : activeUpload.fileSize;
    const percent = total > 0 ? Math.min(100, Math.floor((loaded / total) * 100)) : null;
    if (percent !== activeUpload.activity.percent) {
      activeUpload.activity.loaded = loaded;
      activeUpload.activity.total = total;
      activeUpload.activity.percent = percent;
      activeUpload.activity.updatedAt = new Date().toISOString();
      persistActivity(activeUpload.activity);
    }
    render(event);
  }

  function wrapSocket(sock) {
    if (wrappedSockets.has(sock)) return sock;
    if (typeof sock.sendMessage !== 'function') {
      throw new TypeError('A WhatsApp socket with sendMessage is required for media progress.');
    }

    const sendMessage = sock.sendMessage.bind(sock);
    sock.sendMessage = async (jid, content, options) => {
      const mediaType = Object.keys(MEDIA_LABELS).find(key =>
        content && typeof content === 'object' && key in content);
      if (!mediaType) return sendMessage(jid, content, options);

      const activity = {
        id: `${Date.now()}-${++nextActivityId}`,
        mediaType,
        label: MEDIA_LABELS[mediaType],
        recipientJid: jid,
        description: content.caption || content.fileName || '',
        status: 'queued',
        loaded: 0,
        total: mediaByteLength(content, mediaType),
        percent: 0,
        startedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };
      persistActivity(activity);

      let releaseUpload;
      const previousUpload = uploadQueue;
      uploadQueue = new Promise(resolve => {
        releaseUpload = resolve;
      });
      await previousUpload;

      activity.status = 'uploading';
      activity.updatedAt = new Date().toISOString();
      persistActivity(activity);
      activeUpload = {
        label: MEDIA_LABELS[mediaType],
        fileSize: activity.total,
        activity
      };
      try {
        render({ loaded: 0, total: activeUpload.fileSize });
        const result = await sendMessage(jid, content, options);
        finish(true);
        return result;
      } catch (error) {
        finish(false);
        throw error;
      } finally {
        releaseUpload();
      }
    };

    wrappedSockets.add(sock);
    return sock;
  }

  return { report, wrapSocket };
}

const mediaUploadProgress = createMediaUploadProgress();
export const reportMediaUploadProgress = mediaUploadProgress.report;
export const wrapSocketWithMediaUploadProgress = mediaUploadProgress.wrapSocket;
