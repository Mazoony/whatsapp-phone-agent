import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT_DIR = path.dirname(fileURLToPath(import.meta.url));
export const STUDENT_PAYMENT_LEDGER_FILE = path.join(ROOT_DIR, 'data', 'student_payment_ledger.json');
export const PAYMENT_PERIOD_MS = 30 * 24 * 60 * 60 * 1000;
export const PAYMENT_STATUSES = ['unpaid', 'pending_review', 'paid', 'rejected'];
const PAYMENT_RECEIPT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const RENAME_RETRY_DELAYS_MS = [10, 25, 50, 100];
const PAYMENT_INFORMATION_DELIVERY_LEASE_MS = 2 * 60 * 1000;

function validTimestamp(value) {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) return null;
  return new Date(value).toISOString();
}

export function getLessonPaymentStartAt(student) {
  if (!student || typeof student !== 'object') return null;
  const firstLessonStartedAt = validTimestamp(student.firstLessonStartedAt);
  if (firstLessonStartedAt) return firstLessonStartedAt;

  const trackStates = student.telegramLessonTracks &&
    typeof student.telegramLessonTracks === 'object' &&
    !Array.isArray(student.telegramLessonTracks)
    ? Object.values(student.telegramLessonTracks)
    : [];
  const completionTimestamps = Array.isArray(student.lessonCompletionTimestamps)
    ? student.lessonCompletionTimestamps
    : [];
  const startedAtCandidates = [
    student.deliveredAt,
    student.treasureIsland?.deliveredAt,
    student.lastLessonCompletionAt,
    student.lastTaskSubmission?.submittedAt,
    ...completionTimestamps,
    ...trackStates.map(track => track?.deliveredAt)
  ].map(validTimestamp).filter(Boolean).sort();
  if (startedAtCandidates.length) return startedAtCandidates[0];

  const hasStartedLessons = Boolean(
    student.currentLessonId ||
    (Array.isArray(student.lessonHistory) && student.lessonHistory.length) ||
    (Array.isArray(student.completedLessonIds) && student.completedLessonIds.length) ||
    (Number.isSafeInteger(student.currentLessonIndex) && student.currentLessonIndex >= 0) ||
    student.treasureIsland?.activeLessonId ||
    trackStates.some(track => track?.activeLessonId)
  );
  return hasStartedLessons
    ? validTimestamp(student.enrolledAt) || validTimestamp(student.joinedAt)
    : null;
}

function normalizeAmount(value) {
  if (value === '' || value === null || value === undefined) return null;
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount < 0) {
    throw new Error('Payment amount must be a non-negative number.');
  }
  return amount;
}

function normalizeCurrency(value) {
  if (value === '' || value === null || value === undefined) return null;
  const currency = String(value).trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) {
    throw new Error('Currency must be a three-letter code such as SDG or USD.');
  }
  return currency;
}

function getPaymentInformationDelivery(record) {
  const delivery = record?.paymentInformationDelivery || {};
  const attemptedAt = Date.parse(delivery.attemptedAt || '');
  const inProgress = delivery.inProgress &&
    Number.isFinite(attemptedAt) &&
    Date.now() - attemptedAt < PAYMENT_INFORMATION_DELIVERY_LEASE_MS;
  return {
    status: delivery.sentAt
      ? 'sent'
      : inProgress
        ? 'sending'
        : delivery.attemptedAt
          ? 'failed'
          : 'not_sent',
    sentAt: delivery.sentAt || null,
    attemptedAt: delivery.attemptedAt || null,
    lastError: delivery.lastError || null,
    inProgress: inProgress === true
  };
}

export function getRollingPaymentPeriod(enrolledAt, now = Date.now()) {
  const enrollmentTimestamp = typeof enrolledAt === 'number'
    ? enrolledAt
    : Date.parse(enrolledAt || '');
  const nowTimestamp = typeof now === 'number' ? now : Date.parse(now);
  if (!Number.isFinite(enrollmentTimestamp) || enrollmentTimestamp <= 0) {
    throw new Error('A valid student enrollment date is required for the payment period.');
  }
  if (!Number.isFinite(nowTimestamp) || nowTimestamp <= 0) {
    throw new Error('A valid date is required to calculate the payment period.');
  }
  const cycleIndex = Math.max(0, Math.floor((nowTimestamp - enrollmentTimestamp) / PAYMENT_PERIOD_MS));
  const startTimestamp = enrollmentTimestamp + cycleIndex * PAYMENT_PERIOD_MS;
  return {
    cycle: cycleIndex + 1,
    periodStart: new Date(startTimestamp).toISOString(),
    periodEnd: new Date(startTimestamp + PAYMENT_PERIOD_MS).toISOString()
  };
}

export function formatStudentPaymentStatus(payment) {
  const periodEnd = new Date(Date.parse(payment.periodEnd) - 1).toLocaleDateString('ar-SD');
  const periodStart = new Date(payment.periodStart).toLocaleDateString('ar-SD');
  const amount = payment.amount != null
    ? ` المبلغ المسجل: ${new Intl.NumberFormat('ar-SD').format(payment.amount)} ${payment.currency || ''}.`
    : '';
  const messages = {
    paid: `تم تأكيد دفعك للفترة من ${periodStart} لحدي ${periodEnd}.${amount}`,
    pending_review: `وصل بلاغ دفعك للفترة من ${periodStart} لحدي ${periodEnd} ولسه قيد المراجعة.${amount}`,
    rejected: `ما قدرنا نأكد دفعك للفترة من ${periodStart} لحدي ${periodEnd}. لو شايف إنو في خطأ، كلم الأستاذ.`,
    unpaid: `ما في دفع مؤكد للفترة الحالية، من ${periodStart} لحدي ${periodEnd}، لسه.`
  };
  return messages[payment.status] || messages.unpaid;
}

export function createStudentPaymentLedger(filePath = STUDENT_PAYMENT_LEDGER_FILE) {
  function withLock(operation) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const lockPath = `${filePath}.lock`;
    const deadline = Date.now() + 5000;
    const waitBuffer = new Int32Array(new SharedArrayBuffer(4));
    let lockFd = null;
    while (lockFd === null) {
      try {
        lockFd = fs.openSync(lockPath, 'wx');
        fs.writeSync(lockFd, String(process.pid));
      } catch (error) {
        if (lockFd !== null) {
          fs.closeSync(lockFd);
          lockFd = null;
          try {
            fs.rmSync(lockPath, { force: true });
          } catch (cleanupError) {
            console.error('[Payment Ledger] Could not clean a partial lock file:', cleanupError.message);
          }
        }
        if (error.code !== 'EEXIST') throw error;
        let lockPid = null;
        try {
          const value = fs.readFileSync(lockPath, 'utf8').trim();
          if (/^\d+$/.test(value)) lockPid = Number(value);
        } catch (readError) {
          if (readError.code !== 'ENOENT') throw readError;
        }
        if (lockPid !== null) {
          try {
            process.kill(lockPid, 0);
          } catch (processError) {
            if (processError.code === 'ESRCH') {
              fs.rmSync(lockPath, { force: true });
              continue;
            }
            if (processError.code !== 'EPERM') throw processError;
          }
        }
        if (Date.now() >= deadline) {
          throw new Error(`Timed out waiting for the payment ledger lock in ${filePath}.`);
        }
        Atomics.wait(waitBuffer, 0, 0, 10);
      }
    }
    try {
      return operation();
    } finally {
      fs.closeSync(lockFd);
      fs.rmSync(lockPath, { force: true });
    }
  }

  function read() {
    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (error) {
      if (error.code === 'ENOENT') return {};
      throw error;
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) ||
        Object.entries(parsed).some(([studentKey, record]) =>
          !studentKey || !record || typeof record !== 'object' ||
          !validTimestamp(record.enrolledAt) ||
          !record.periods || typeof record.periods !== 'object' || Array.isArray(record.periods) ||
          Object.entries(record.periods).some(([periodStart, period]) =>
            periodStart !== period?.periodStart ||
            !validTimestamp(period.periodStart) ||
            !validTimestamp(period.periodEnd) ||
            !PAYMENT_STATUSES.includes(period.status) ||
            (period.amount != null && (!Number.isFinite(period.amount) || period.amount < 0)) ||
            (period.currency != null && !/^[A-Z]{3}$/.test(period.currency))) ||
          (record.paymentInformationDelivery != null &&
            (typeof record.paymentInformationDelivery !== 'object' ||
             Array.isArray(record.paymentInformationDelivery) ||
             (record.paymentInformationDelivery.attemptedAt != null &&
              !validTimestamp(record.paymentInformationDelivery.attemptedAt)) ||
             (record.paymentInformationDelivery.sentAt != null &&
              !validTimestamp(record.paymentInformationDelivery.sentAt)) ||
             (record.paymentInformationDelivery.attemptId != null &&
              typeof record.paymentInformationDelivery.attemptId !== 'string') ||
             (record.paymentInformationDelivery.inProgress != null &&
              typeof record.paymentInformationDelivery.inProgress !== 'boolean') ||
             (record.paymentInformationDelivery.lastError != null &&
              typeof record.paymentInformationDelivery.lastError !== 'string'))))) {
      throw new Error(`Invalid student payment ledger file: ${filePath}`);
    }
    return parsed;
  }

  function write(ledger) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
    try {
      fs.writeFileSync(temporaryPath, JSON.stringify(ledger, null, 2), 'utf8');
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
        console.error('[Payment Ledger] Could not clean temporary ledger file:', cleanupError.message);
      }
      throw error;
    }
  }

  function currentPeriodFor(record, enrolledAt, now) {
    const effectiveEnrollment = validTimestamp(enrolledAt) || record?.enrolledAt;
    if (!effectiveEnrollment) {
      throw new Error('Student enrollment date is not available for the payment ledger.');
    }
    const bounds = getRollingPaymentPeriod(effectiveEnrollment, now);
    const existing = record?.periods?.[bounds.periodStart];
    return {
      ...bounds,
      ...(existing || {
        status: 'unpaid',
        amount: null,
        currency: null,
        source: null,
        claimedAt: null,
        reviewedAt: null,
        paidAt: null,
        details: null,
        updatedAt: null
      })
    };
  }

  function reanchorRecord(record, enrolledAt, now) {
    if (!record || record.enrolledAt === enrolledAt) return false;
    const previousBounds = getRollingPaymentPeriod(record.enrolledAt, now);
    const nextBounds = getRollingPaymentPeriod(enrolledAt, now);
    const previousCurrent = record.periods[previousBounds.periodStart];
    if (previousCurrent && previousCurrent.status !== 'unpaid' &&
        previousBounds.periodStart !== nextBounds.periodStart) {
      const nextCurrent = record.periods[nextBounds.periodStart];
      const carryForward = nextCurrent?.status === 'paid' ? nextCurrent : previousCurrent;
      record.periods[nextBounds.periodStart] = {
        ...previousCurrent,
        ...(nextCurrent || {}),
        ...nextBounds,
        status: carryForward.status,
        amount: carryForward.amount ?? previousCurrent.amount ?? null,
        currency: carryForward.currency || previousCurrent.currency || null,
        source: carryForward.source || previousCurrent.source || null,
        claimedAt: carryForward.claimedAt || previousCurrent.claimedAt || null,
        reviewedAt: carryForward.reviewedAt || previousCurrent.reviewedAt || null,
        paidAt: carryForward.paidAt || previousCurrent.paidAt || null,
        details: carryForward.details || previousCurrent.details || null
      };
      delete record.periods[previousBounds.periodStart];
    }
    record.enrolledAt = enrolledAt;
    return true;
  }

  return {
    list() {
      return read();
    },
    getPaymentInformationDelivery(studentKey) {
      if (typeof studentKey !== 'string' || !studentKey.trim()) {
        throw new Error('A student identifier is required to read payment information delivery status.');
      }
      return getPaymentInformationDelivery(read()[studentKey]);
    },
    beginPaymentInformationDelivery(studentKey, {
      enrolledAt,
      force = false,
      attemptedAt = new Date().toISOString()
    } = {}) {
      if (typeof studentKey !== 'string' || !studentKey.trim()) {
        throw new Error('A student identifier is required to send payment information.');
      }
      const normalizedEnrolledAt = validTimestamp(enrolledAt);
      if (!normalizedEnrolledAt) {
        throw new Error('A valid enrollment date is required to send payment information.');
      }
      const normalizedAttemptedAt = validTimestamp(attemptedAt);
      if (!normalizedAttemptedAt) {
        throw new Error('A valid payment information delivery date is required.');
      }
      return withLock(() => {
        const ledger = read();
        const record = ledger[studentKey] || {
          enrolledAt: normalizedEnrolledAt,
          periods: {}
        };
        reanchorRecord(record, normalizedEnrolledAt, Date.now());
        const previous = record.paymentInformationDelivery || {};
        const previousAttemptTime = Date.parse(previous.attemptedAt || '');
        const attemptIsActive = previous.inProgress &&
          Number.isFinite(previousAttemptTime) &&
          Date.now() - previousAttemptTime < PAYMENT_INFORMATION_DELIVERY_LEASE_MS;
        if (attemptIsActive || (!force && previous.attemptedAt)) return null;

        const attemptId = randomUUID();
        record.paymentInformationDelivery = {
          ...previous,
          attemptedAt: normalizedAttemptedAt,
          attemptId,
          inProgress: true,
          lastError: null
        };
        ledger[studentKey] = record;
        write(ledger);
        return { attemptId };
      });
    },
    completePaymentInformationDelivery(studentKey, {
      attemptId,
      sent,
      sentAt = new Date().toISOString(),
      error = null
    } = {}) {
      if (typeof studentKey !== 'string' || !studentKey.trim() ||
          typeof attemptId !== 'string' || !attemptId) {
        throw new Error('A student and payment information delivery attempt are required.');
      }
      if (typeof sent !== 'boolean') {
        throw new Error('Payment information delivery result must be a boolean.');
      }
      const normalizedSentAt = validTimestamp(sentAt);
      if (!normalizedSentAt) {
        throw new Error('A valid payment information delivery date is required.');
      }
      if (!sent && (typeof error !== 'string' || !error.trim())) {
        throw new Error('A failure reason is required for an unsuccessful payment information delivery.');
      }
      return withLock(() => {
        const ledger = read();
        const record = ledger[studentKey];
        const previous = record?.paymentInformationDelivery;
        if (!previous || previous.attemptId !== attemptId) return false;
        record.paymentInformationDelivery = {
          ...previous,
          ...(sent ? { sentAt: normalizedSentAt } : {}),
          inProgress: false,
          attemptId: null,
          lastError: sent ? null : error.trim().slice(0, 500)
        };
        write(ledger);
        return true;
      });
    },
    getCurrent(studentKey, enrolledAt, now = Date.now()) {
      if (typeof studentKey !== 'string' || !studentKey.trim()) {
        throw new Error('A student identifier is required to read payment status.');
      }
      const normalizedEnrolledAt = validTimestamp(enrolledAt);
      return withLock(() => {
        const ledger = read();
        const record = ledger[studentKey];
        if (record && normalizedEnrolledAt &&
            reanchorRecord(record, normalizedEnrolledAt, now)) {
          write(ledger);
        }
        const period = currentPeriodFor(record, normalizedEnrolledAt, now);
        return {
          studentKey,
          enrolledAt: record?.enrolledAt || normalizedEnrolledAt,
          ...period
        };
      });
    },
    getCurrentForStudents(students, now = Date.now()) {
      if (!Array.isArray(students)) {
        throw new Error('A list of students is required to read payment statuses.');
      }
      return withLock(() => {
        const ledger = read();
        let changed = false;
        const currentStudents = students.map(({ studentKey, enrolledAt }) => {
          if (typeof studentKey !== 'string' || !studentKey.trim()) {
            throw new Error('A student identifier is required to read payment status.');
          }
          const normalizedEnrolledAt = validTimestamp(enrolledAt);
          const record = ledger[studentKey];
          if (record && normalizedEnrolledAt &&
              reanchorRecord(record, normalizedEnrolledAt, now)) {
            changed = true;
          }
          return {
            studentKey,
            paymentInformationDelivery: getPaymentInformationDelivery(record),
            payment: {
              studentKey,
              enrolledAt: record?.enrolledAt || normalizedEnrolledAt,
              ...currentPeriodFor(record, normalizedEnrolledAt, now)
            }
          };
        });
        if (changed) write(ledger);
        return currentStudents;
      });
    },
    recordClaim(studentKey, {
      enrolledAt,
      source = 'student-claim',
      details = null,
      claimedAt = new Date().toISOString()
    } = {}) {
      if (typeof studentKey !== 'string' || !studentKey.trim()) {
        throw new Error('A student identifier is required to record a payment claim.');
      }
      const normalizedEnrolledAt = validTimestamp(enrolledAt) || validTimestamp(claimedAt);
      if (!normalizedEnrolledAt) throw new Error('A valid enrollment date is required to record a payment claim.');
      const normalizedClaimedAt = validTimestamp(claimedAt);
      if (!normalizedClaimedAt) throw new Error('A valid claim date is required.');
      return withLock(() => {
        const ledger = read();
        const record = ledger[studentKey] || { enrolledAt: normalizedEnrolledAt, periods: {} };
        reanchorRecord(record, normalizedEnrolledAt, normalizedClaimedAt);
        const bounds = getRollingPaymentPeriod(normalizedEnrolledAt, normalizedClaimedAt);
        const previous = record.periods[bounds.periodStart];
        const period = {
          ...bounds,
          status: previous?.status === 'paid' ? 'paid' : 'pending_review',
          amount: details?.amount != null ? normalizeAmount(details.amount) : previous?.amount ?? null,
          currency: details?.currency
            ? normalizeCurrency(details.currency)
            : previous?.currency ?? null,
          source,
          claimedAt: normalizedClaimedAt,
          reviewedAt: previous?.status === 'paid' ? previous.reviewedAt : null,
          paidAt: previous?.status === 'paid' ? previous.paidAt : null,
          details: details && typeof details === 'object' ? {
            bank: details.bank || null,
            transactionId: details.transactionId || null,
            recipientName: details.recipientName || null,
            recipientAccount: details.recipientAccount || null,
            receiptDate: details.date || null,
            receiptId: PAYMENT_RECEIPT_ID_PATTERN.test(details.receiptId || '')
              ? details.receiptId
              : previous?.details?.receiptId || null,
            reason: details.reason || null
          } : previous?.details || null,
          updatedAt: new Date().toISOString()
        };
        record.periods[bounds.periodStart] = period;
        ledger[studentKey] = record;
        write(ledger);
        return { studentKey, enrolledAt: record.enrolledAt, ...period };
      });
    },
    setStatus(studentKey, {
      enrolledAt,
      status,
      amount,
      currency,
      note = null,
      reviewedAt = new Date().toISOString()
    } = {}) {
      if (typeof studentKey !== 'string' || !studentKey.trim()) {
        throw new Error('A student identifier is required to update payment status.');
      }
      if (!PAYMENT_STATUSES.includes(status)) {
        throw new Error('Payment status must be unpaid, pending_review, paid, or rejected.');
      }
      const normalizedEnrolledAt = validTimestamp(enrolledAt);
      if (!normalizedEnrolledAt) throw new Error('A valid enrollment date is required to update payment status.');
      const normalizedReviewedAt = validTimestamp(reviewedAt);
      if (!normalizedReviewedAt) throw new Error('A valid review date is required.');
      return withLock(() => {
        const ledger = read();
        const record = ledger[studentKey] || { enrolledAt: normalizedEnrolledAt, periods: {} };
        reanchorRecord(record, normalizedEnrolledAt, normalizedReviewedAt);
        const bounds = getRollingPaymentPeriod(normalizedEnrolledAt, normalizedReviewedAt);
        const previous = record.periods[bounds.periodStart] || {};
        const updatedPeriod = {
          ...bounds,
          status,
          amount: amount === undefined ? previous.amount ?? null : normalizeAmount(amount),
          currency: currency === undefined ? previous.currency ?? null : normalizeCurrency(currency),
          source: previous.source || 'admin',
          claimedAt: previous.claimedAt || null,
          reviewedAt: status === 'pending_review' || status === 'unpaid' ? null : normalizedReviewedAt,
          paidAt: status === 'paid' ? normalizedReviewedAt : null,
          details: note === null ? previous.details || null : {
            ...(previous.details || {}),
            adminNote: String(note).trim().slice(0, 500) || null
          },
          updatedAt: new Date().toISOString()
        };
        record.periods[bounds.periodStart] = updatedPeriod;
        ledger[studentKey] = record;
        write(ledger);
        return { studentKey, enrolledAt: record.enrolledAt, ...updatedPeriod };
      });
    }
  };
}
