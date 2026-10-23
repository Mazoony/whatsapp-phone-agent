import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT_DIR = path.dirname(fileURLToPath(import.meta.url));
export const STUDENT_PAYMENT_LEDGER_FILE = path.join(ROOT_DIR, 'data', 'student_payment_ledger.json');
export const PAYMENT_PERIOD_MS = 30 * 24 * 60 * 60 * 1000;
export const PAYMENT_STATUSES = ['unpaid', 'pending_review', 'paid', 'rejected'];

function validTimestamp(value) {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) return null;
  return new Date(value).toISOString();
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
            (period.currency != null && !/^[A-Z]{3}$/.test(period.currency))))) {
      throw new Error(`Invalid student payment ledger file: ${filePath}`);
    }
    return parsed;
  }

  function write(ledger) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const temporaryPath = `${filePath}.${process.pid}.tmp`;
    try {
      fs.writeFileSync(temporaryPath, JSON.stringify(ledger, null, 2), 'utf8');
      fs.renameSync(temporaryPath, filePath);
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
    const effectiveEnrollment = record?.enrolledAt || validTimestamp(enrolledAt);
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

  return {
    list() {
      return read();
    },
    getCurrent(studentKey, enrolledAt, now = Date.now()) {
      if (typeof studentKey !== 'string' || !studentKey.trim()) {
        throw new Error('A student identifier is required to read payment status.');
      }
      const ledger = read();
      const record = ledger[studentKey];
      const period = currentPeriodFor(record, enrolledAt, now);
      return { studentKey, enrolledAt: record?.enrolledAt || validTimestamp(enrolledAt), ...period };
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
        const bounds = getRollingPaymentPeriod(record.enrolledAt, normalizedClaimedAt);
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
        const bounds = getRollingPaymentPeriod(record.enrolledAt, normalizedReviewedAt);
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
