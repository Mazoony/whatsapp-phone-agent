import fs from 'node:fs';
import path from 'node:path';

export const SCHEDULED_LESSONS_FILE = path.resolve('data', 'scheduled_lessons.json');
export const SCHEDULE_TIME_ZONE = 'Africa/Khartoum';
const SUDAN_UTC_OFFSET_MINUTES = 120;
const DAY_MS = 24 * 60 * 60 * 1000;

export function getNextDailyLessonTime(after = Date.now()) {
  const timestamp = after instanceof Date ? after.getTime() : Number(after);
  if (!Number.isFinite(timestamp)) throw new Error('Lesson schedule reference time is invalid.');
  return new Date(timestamp + DAY_MS).toISOString();
}

function normalizeDigits(text) {
  return text.replace(/[٠-٩]/g, digit => String('٠١٢٣٤٥٦٧٨٩'.indexOf(digit)))
    .replace(/[۰-۹]/g, digit => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(digit)));
}

function normalizedText(text) {
  return normalizeDigits(text.toLowerCase())
    .replace(/[أإآ]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/[ًٌٍَُِّْـ]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function isLessonScheduleRequest(text) {
  if (typeof text !== 'string') return false;
  const normalized = normalizedText(text);
  const mentionsLesson = /\b(?:lesson|video|class)\b/.test(normalized) ||
    /(?:درس|حصة|حصه|فيديو)/.test(normalized);
  const mentionsSchedule = /\b(?:at|around|by|tomorrow|today|on|schedule|scheduled|morning|afternoon|evening|tonight|every day|daily|every week|weekly)\b/.test(normalized) ||
    /\btime\b|specific time|(?:الساعة|الساعه|بكرة|بكره|غدا|غداً|اليوم|الصباح|صباح|الظهر|عصر|المساء|مسا|بالليل|ليل|جدول|موعد|وقت|زمن|السبت|الاحد|الاثنين|الثلاثاء|الاربعاء|الخميس|الجمعة|كل يوم|يوميا|كل اسبوع)/.test(normalized);
  const asksToSend = /\b(?:send|sending|deliver|get|receive|want|need|schedule|book)\b/.test(normalized) ||
    /(?:ارسل|رسل|ارسلي|رسل لي|ارسلي لي|ابعث|ابعت|تبعت|ترسل|ترسل لي|ورسل|وريني|عايز|عايزة|عايزه|داير|دايره|محتاج|محتاجه|استلم|جدول|رتب)/.test(normalized);
  return mentionsLesson && mentionsSchedule && asksToSend;
}

export function isRecurringLessonScheduleRequest(text) {
  if (typeof text !== 'string') return false;
  const normalized = normalizedText(text);
  return /\b(?:every day|daily|every week|weekly|each day|each week)\b|كل يوم|يوميا|يومياً|كل اسبوع|كل اسبوعين/.test(normalized);
}

export function looksLikeScheduleDateTime(text) {
  if (typeof text !== 'string') return false;
  const normalized = normalizedText(text);
  return /\b(?:today|tomorrow|day after tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday|january|february|march|april|may|june|july|august|september|october|november|december)\b/.test(normalized) ||
    /\b\d{4}-\d{1,2}-\d{1,2}\b|\b\d{1,2}[/. -]\d{1,2}[/. -]\d{4}\b|\b\d{1,2}:\d{2}\b|\b\d{1,2}\s*(?:am|pm)\b|(?:الساعة|الساعه|بكرة|بكره|غدا|اليوم|صباح|الظهر|عصر|مساء|مسا|ليل|السبت|الاحد|الاثنين|الثلاثاء|الاربعاء|الخميس|الجمعة)/.test(normalized);
}

function sudanDateParts(date) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: SCHEDULE_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23'
  }).formatToParts(date);
  return Object.fromEntries(parts.filter(part => part.type !== 'literal').map(part => [part.type, Number(part.value)]));
}

function parseDate(text, now) {
  const parts = sudanDateParts(now);
  const currentDate = new Date(Date.UTC(parts.year, parts.month - 1, parts.day));
  const addDays = days => new Date(currentDate.getTime() + days * 86_400_000);
  const normalized = normalizedText(text);
  if (/\b(?:day after tomorrow)\b|بعد غد|بعد بكرة|بعد بكره/.test(normalized)) {
    return addDays(2);
  }
  if (/\b(?:tomorrow)\b|بكرة|بكره|غدا|غداً/.test(normalized)) return addDays(1);
  if (/\b(?:today)\b|اليوم/.test(normalized)) return currentDate;

  const explicit = normalized.match(/\b(\d{4})-(\d{1,2})-(\d{1,2})\b/) ||
    normalized.match(/\b(\d{1,2})[/. -](\d{1,2})[/. -](\d{4})\b/);
  if (explicit) {
    const [, first, second, third] = explicit;
    const year = explicit[0].includes('-') && first.length === 4 ? Number(first) : Number(third);
    const month = explicit[0].includes('-') && first.length === 4 ? Number(second) : Number(second);
    const day = explicit[0].includes('-') && first.length === 4 ? Number(third) : Number(first);
    const date = new Date(Date.UTC(year, month - 1, day));
    return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
      ? date
      : null;
  }

  const weekdayNames = [
    ['sunday', 'الاحد', 'حد'],
    ['monday', 'الاثنين', 'اتنين'],
    ['tuesday', 'الثلاثاء', 'تلاتاء', 'تلاتا'],
    ['wednesday', 'الاربعاء', 'اربعاء'],
    ['thursday', 'الخميس', 'خميس'],
    ['friday', 'الجمعة', 'جمعه'],
    ['saturday', 'السبت', 'سبت']
  ];
  const currentWeekday = currentDate.getUTCDay();
  for (const [index, names] of weekdayNames.entries()) {
    if (names.some(name => normalized.includes(name))) {
      const delta = (index - currentWeekday + 7) % 7;
      return addDays(delta);
    }
  }
  return null;
}

function parseTime(text) {
  const normalized = normalizedText(text);
  const partOfDay = /(?:صباح|الصباح|morning)/.test(normalized) ? 'am' :
    /(?:ظهر|الظهر|عصر|العصر|مساء|المساء|مسا|ليل|بالليل|afternoon|evening|tonight|night)/.test(normalized)
      ? 'pm'
      : null;
  const clock = normalized.match(/\b(\d{1,2}):([0-5]\d)\b/) ||
    normalized.match(/\b(\d{1,2})\s*(am|pm)\b/) ||
    normalized.match(/(?:\bat\b|\baround\b|\bby\b|الساعة|الساعه|ساعة)\s*(\d{1,2})(?:\s*(am|pm))?/);
  if (!clock) return { status: 'missing' };

  const hour = Number(clock[1]);
  const minute = clock[2] && /^\d{2}$/.test(clock[2]) ? Number(clock[2]) : 0;
  const explicitSuffix = normalized.match(/\b(am|pm)\b/)?.[1];
  const suffix = clock[3] ||
    (clock[2] && /^(?:am|pm)$/.test(clock[2]) ? clock[2] : null) ||
    explicitSuffix ||
    partOfDay;
  if (hour > 23 || minute > 59) return { status: 'invalid' };
  if (suffix === 'am' && hour === 12) return { status: 'valid', hour: 0, minute };
  if (suffix === 'pm' && hour < 12) return { status: 'valid', hour: hour + 12, minute };
  if (!suffix && hour >= 1 && hour <= 11) return { status: 'ambiguous' };
  return { status: 'valid', hour, minute };
}

export function parseScheduledDateTime(text, now = new Date()) {
  const date = parseDate(text, now);
  const time = parseTime(text);
  if (time.status === 'invalid') return { status: 'invalid', reason: 'time' };
  if (time.status === 'ambiguous') {
    return {
      status: 'ambiguous',
      reason: 'am_pm',
      missing: date ? [] : ['date']
    };
  }
  if (!date || time.status === 'missing') {
    return {
      status: 'incomplete',
      missing: [...(!date ? ['date'] : []), ...(time.status === 'missing' ? ['time'] : [])]
    };
  }

  const scheduledAt = new Date(Date.UTC(
    date.getUTCFullYear(),
    date.getUTCMonth(),
    date.getUTCDate(),
    time.hour,
    time.minute
  ) - SUDAN_UTC_OFFSET_MINUTES * 60_000);
  if (scheduledAt.getTime() <= now.getTime()) return { status: 'past' };
  return { status: 'valid', scheduledAt: scheduledAt.toISOString() };
}

export function formatScheduledDateTime(value, locale = 'ar-SD') {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error('Scheduled lesson time is invalid.');
  return new Intl.DateTimeFormat(locale, {
    timeZone: SCHEDULE_TIME_ZONE,
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23'
  }).format(date);
}

function emptyState() {
  return { schedules: [], pendingByJid: {} };
}

export function createScheduledLessonStore({
  filePath = SCHEDULED_LESSONS_FILE,
  now = () => Date.now()
} = {}) {
  const read = () => {
    if (!fs.existsSync(filePath)) return emptyState();
    const value = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (!value || !Array.isArray(value.schedules) ||
        !value.pendingByJid || typeof value.pendingByJid !== 'object' ||
        Array.isArray(value.pendingByJid)) {
      throw new Error(`Invalid scheduled lesson data in ${filePath}`);
    }
    return value;
  };
  const write = value => {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const temporaryPath = `${filePath}.${process.pid}.tmp`;
    fs.writeFileSync(temporaryPath, JSON.stringify(value, null, 2), 'utf8');
    fs.renameSync(temporaryPath, filePath);
  };

  return {
    list() {
      return read().schedules.sort((left, right) => left.scheduledAt.localeCompare(right.scheduledAt));
    },
    getPending(jid) {
      const state = read();
      const pending = state.pendingByJid[jid];
      const createdAt = Date.parse(pending?.createdAt || '');
      if (!pending) return null;
      if (!Number.isFinite(createdAt) || now() - createdAt > 24 * 60 * 60 * 1000) {
        delete state.pendingByJid[jid];
        write(state);
        return null;
      }
      return pending;
    },
    setPending(jid, value) {
      const state = read();
      state.pendingByJid[jid] = value;
      write(state);
    },
    clearPending(jid) {
      const state = read();
      delete state.pendingByJid[jid];
      write(state);
    },
    create(schedule) {
      const state = read();
      const timestamp = now();
      const runAt = Date.parse(schedule.scheduledAt);
      if (!Number.isFinite(runAt) || runAt <= timestamp) {
        throw new Error('Scheduled lesson time must be in the future.');
      }
      if (typeof schedule.jid !== 'string' || typeof schedule.gradeKey !== 'string' ||
          !Number.isInteger(schedule.lessonIndex) || typeof schedule.lessonId !== 'string' ||
          typeof schedule.lessonTitle !== 'string') {
        throw new Error('Scheduled lesson details are incomplete.');
      }
      const createdAt = new Date(timestamp).toISOString();
      const record = {
        id: `${timestamp}-${Math.random().toString(36).slice(2, 10)}`,
        jid: schedule.jid,
        phoneJid: schedule.phoneJid || schedule.jid,
        studentName: schedule.studentName || schedule.jid,
        gradeKey: schedule.gradeKey,
        lessonIndex: schedule.lessonIndex,
        lessonId: schedule.lessonId,
        lessonTitle: schedule.lessonTitle,
        scheduledAt: new Date(runAt).toISOString(),
        status: 'scheduled',
        createdAt,
        updatedAt: createdAt
      };
      state.schedules.push(record);
      delete state.pendingByJid[schedule.jid];
      write(state);
      return record;
    },
    update(id, updater) {
      const state = read();
      const index = state.schedules.findIndex(schedule => schedule.id === id);
      if (index < 0) return null;
      const current = state.schedules[index];
      if (current.status !== 'scheduled') {
        throw new Error('Only scheduled lessons can be changed.');
      }
      const updated = updater(current);
      if (updated.scheduledAt !== current.scheduledAt) {
        const runAt = Date.parse(updated.scheduledAt);
        if (!Number.isFinite(runAt) || runAt <= now()) {
          throw new Error('Scheduled lesson time must be in the future.');
        }
        updated.scheduledAt = new Date(runAt).toISOString();
      }
      updated.updatedAt = new Date(now()).toISOString();
      state.schedules[index] = updated;
      write(state);
      return updated;
    },
    claimDue() {
      const timestamp = now();
      const state = read();
      const due = state.schedules.find(schedule =>
        schedule.status === 'scheduled' && Date.parse(schedule.scheduledAt) <= timestamp);
      if (!due) return null;
      due.status = 'sending';
      due.updatedAt = new Date(timestamp).toISOString();
      write(state);
      return due;
    },
    complete(id, status, error = null) {
      if (!['sent', 'failed'].includes(status)) throw new Error('Invalid scheduled lesson result.');
      return this.updateStatus(id, status, error);
    },
    updateStatus(id, status, error = null) {
      const state = read();
      const schedule = state.schedules.find(item => item.id === id);
      if (!schedule) return null;
      schedule.status = status;
      schedule.error = error;
      schedule.updatedAt = new Date(now()).toISOString();
      if (status === 'sent' || status === 'failed') schedule.completedAt = schedule.updatedAt;
      write(state);
      return schedule;
    },
    reschedule(id, scheduledAt) {
      const runAt = Date.parse(scheduledAt);
      if (!Number.isFinite(runAt) || runAt <= now()) {
        throw new Error('Scheduled lesson time must be in the future.');
      }
      const state = read();
      const schedule = state.schedules.find(item => item.id === id);
      if (!schedule || !['scheduled', 'sending'].includes(schedule.status)) return null;
      schedule.status = 'scheduled';
      schedule.scheduledAt = new Date(runAt).toISOString();
      schedule.updatedAt = new Date(now()).toISOString();
      write(state);
      return schedule;
    },
    recoverInterrupted() {
      const state = read();
      let changed = false;
      for (const schedule of state.schedules) {
        if (schedule.status === 'sending') {
          schedule.status = 'failed';
          schedule.error = 'Agent restarted while delivery was in progress; delivery result is uncertain.';
          schedule.updatedAt = new Date(now()).toISOString();
          schedule.completedAt = schedule.updatedAt;
          changed = true;
        }
      }
      if (changed) write(state);
    },
    cancel(id) {
      return this.update(id, current => ({ ...current, status: 'cancelled' }));
    }
  };
}
