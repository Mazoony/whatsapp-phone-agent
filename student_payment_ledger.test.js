import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  createStudentPaymentLedger,
  formatStudentPaymentStatus,
  getLessonPaymentStartAt,
  getRollingPaymentPeriod,
  PAYMENT_PERIOD_MS
} from './student_payment_ledger.js';

test('student payment status messages are in Sudanese Arabic', () => {
  const payment = {
    periodStart: '2026-01-01T12:00:00.000Z',
    periodEnd: '2026-01-31T12:00:00.000Z',
    amount: 17000,
    currency: 'SDG'
  };
  assert.match(formatStudentPaymentStatus({ ...payment, status: 'paid' }), /تم تأكيد دفعك/);
  assert.match(formatStudentPaymentStatus({ ...payment, status: 'pending_review' }), /وصل بلاغ دفعك/);
  assert.match(formatStudentPaymentStatus({ ...payment, status: 'rejected' }), /ما قدرنا نأكد دفعك/);
  assert.match(formatStudentPaymentStatus({ ...payment, status: 'unpaid' }), /ما في دفع مؤكد/);
});

test('rolling payment periods begin at the first lesson and advance every 30 days', () => {
  const enrolledAt = Date.parse('2026-01-01T12:00:00.000Z');
  assert.deepEqual(getRollingPaymentPeriod(enrolledAt, enrolledAt + 10 * 24 * 60 * 60 * 1000), {
    cycle: 1,
    periodStart: new Date(enrolledAt).toISOString(),
    periodEnd: new Date(enrolledAt + PAYMENT_PERIOD_MS).toISOString()
  });
  assert.deepEqual(getRollingPaymentPeriod(enrolledAt, enrolledAt + PAYMENT_PERIOD_MS + 5), {
    cycle: 2,
    periodStart: new Date(enrolledAt + PAYMENT_PERIOD_MS).toISOString(),
    periodEnd: new Date(enrolledAt + 2 * PAYMENT_PERIOD_MS).toISOString()
  });
});

test('lesson payment start prefers first delivery evidence and excludes unstarted students', () => {
  assert.equal(getLessonPaymentStartAt({
    enrolledAt: '2026-01-01T12:00:00.000Z',
    joinedAt: '2026-01-01T12:00:00.000Z',
    deliveredAt: '2026-01-20T12:00:00.000Z',
    lessonCompletionTimestamps: ['2026-01-10T12:00:00.000Z']
  }), '2026-01-10T12:00:00.000Z');
  assert.equal(getLessonPaymentStartAt({
    enrolledAt: '2026-01-01T12:00:00.000Z',
    joinedAt: '2026-01-01T12:00:00.000Z'
  }), null);
  assert.equal(getLessonPaymentStartAt({
    enrolledAt: '2026-01-01T12:00:00.000Z',
    treasureIsland: { deliveredAt: '2026-01-10T12:00:00.000Z' }
  }), '2026-01-10T12:00:00.000Z');
});

test('payment claims remain pending until reviewed and a later period starts unpaid', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'student-payment-ledger-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const ledger = createStudentPaymentLedger(path.join(directory, 'ledger.json'));
  const enrolledAt = '2026-01-01T12:00:00.000Z';
  const claimedAt = '2026-01-10T12:00:00.000Z';
  const studentKey = 'telegram:-100123:44';

  const claim = ledger.recordClaim(studentKey, {
    enrolledAt,
    claimedAt,
    source: 'telegram-receipt',
    details: { amount: 17000, currency: 'SDG', bank: 'Bankak', transactionId: 'TX-1' }
  });
  assert.equal(claim.status, 'pending_review');
  assert.equal(claim.amount, 17000);
  assert.equal(claim.details.bank, 'Bankak');
  assert.equal(ledger.getCurrent(studentKey, enrolledAt, Date.parse(claimedAt)).status, 'pending_review');

  const confirmed = ledger.setStatus(studentKey, {
    enrolledAt,
    status: 'paid',
    reviewedAt: '2026-01-11T12:00:00.000Z'
  });
  assert.equal(confirmed.status, 'paid');
  assert.equal(confirmed.amount, 17000);
  assert.equal(confirmed.currency, 'SDG');
  assert.equal(confirmed.source, 'telegram-receipt');
  assert.ok(confirmed.paidAt);
  assert.equal(ledger.getCurrent(studentKey, enrolledAt, Date.parse(claimedAt)).status, 'paid');
  assert.equal(
    createStudentPaymentLedger(path.join(directory, 'ledger.json'))
      .getCurrent(studentKey, enrolledAt, Date.parse(claimedAt)).status,
    'paid'
  );

  const rejected = ledger.setStatus('telegram:-100123:45', {
    enrolledAt,
    status: 'rejected',
    note: 'Could not verify the transfer',
    reviewedAt: '2026-01-11T12:00:00.000Z'
  });
  assert.equal(rejected.status, 'rejected');
  assert.equal(rejected.details.adminNote, 'Could not verify the transfer');

  const nextPeriod = ledger.getCurrent(
    studentKey,
    enrolledAt,
    Date.parse(enrolledAt) + PAYMENT_PERIOD_MS + 1
  );
  assert.equal(nextPeriod.status, 'unpaid');
  assert.equal(nextPeriod.cycle, 2);
});

test('changing the payment anchor preserves the active payment in the new lesson period', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'student-payment-reanchor-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const ledger = createStudentPaymentLedger(path.join(directory, 'ledger.json'));
  const studentKey = 'telegram:-100123:44';
  const joinedAt = '2026-02-01T12:00:00.000Z';
  const lessonStartedAt = '2026-02-10T12:00:00.000Z';
  const reviewedAt = '2026-03-10T12:00:00.000Z';

  ledger.setStatus(studentKey, {
    enrolledAt: joinedAt,
    status: 'paid',
    amount: 17000,
    currency: 'SDG',
    reviewedAt
  });

  const payment = ledger.getCurrent(
    studentKey,
    lessonStartedAt,
    Date.parse('2026-03-15T12:00:00.000Z')
  );
  assert.equal(payment.status, 'paid');
  assert.equal(payment.periodStart, '2026-03-12T12:00:00.000Z');
  assert.equal(payment.paidAt, reviewedAt);
  const record = ledger.list()[studentKey];
  assert.equal(record.enrolledAt, lessonStartedAt);
  assert.deepEqual(Object.keys(record.periods), [payment.periodStart]);
});

test('payment information delivery is tracked and can be manually retried', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'student-payment-info-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const ledger = createStudentPaymentLedger(path.join(directory, 'ledger.json'));
  const studentKey = 'telegram:-100123:44';
  const enrolledAt = '2026-01-01T12:00:00.000Z';

  assert.equal(ledger.getPaymentInformationDelivery(studentKey).status, 'not_sent');
  const firstAttempt = ledger.beginPaymentInformationDelivery(studentKey, { enrolledAt });
  assert.ok(firstAttempt);
  assert.equal(
    ledger.beginPaymentInformationDelivery(studentKey, { enrolledAt }),
    null
  );
  assert.equal(ledger.getPaymentInformationDelivery(studentKey).status, 'sending');

  assert.equal(ledger.completePaymentInformationDelivery(studentKey, {
    attemptId: firstAttempt.attemptId,
    sent: false,
    error: 'Telegram unavailable'
  }), true);
  assert.equal(ledger.getPaymentInformationDelivery(studentKey).status, 'failed');
  assert.equal(ledger.getPaymentInformationDelivery(studentKey).lastError, 'Telegram unavailable');
  assert.equal(
    ledger.beginPaymentInformationDelivery(studentKey, { enrolledAt }),
    null
  );

  const manualAttempt = ledger.beginPaymentInformationDelivery(studentKey, {
    enrolledAt,
    force: true
  });
  assert.ok(manualAttempt);
  assert.equal(ledger.completePaymentInformationDelivery(studentKey, {
    attemptId: manualAttempt.attemptId,
    sent: true,
    sentAt: '2026-01-02T12:00:00.000Z'
  }), true);
  const delivery = ledger.getPaymentInformationDelivery(studentKey);
  assert.equal(delivery.status, 'sent');
  assert.equal(delivery.sentAt, '2026-01-02T12:00:00.000Z');
  assert.ok(delivery.attemptedAt);
  assert.equal(delivery.lastError, null);
  assert.equal(delivery.inProgress, false);
});

test('payment statuses for multiple students read the ledger once', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'student-payment-batch-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, 'ledger.json');
  const ledger = createStudentPaymentLedger(filePath);
  const enrolledAt = '2026-01-01T12:00:00.000Z';
  const now = Date.parse('2026-01-10T12:00:00.000Z');
  ledger.setStatus('student-paid', {
    enrolledAt,
    status: 'paid',
    reviewedAt: '2026-01-05T12:00:00.000Z'
  });

  const originalReadFileSync = fs.readFileSync;
  let ledgerReadCount = 0;
  fs.readFileSync = function(file, ...args) {
    if (path.resolve(String(file)) === path.resolve(filePath)) ledgerReadCount += 1;
    return originalReadFileSync.call(this, file, ...args);
  };
  let currentPayments;
  try {
    currentPayments = ledger.getCurrentForStudents([
      { studentKey: 'student-paid', enrolledAt },
      { studentKey: 'student-unpaid', enrolledAt }
    ], now);
  } finally {
    fs.readFileSync = originalReadFileSync;
  }

  assert.equal(ledgerReadCount, 1);
  assert.deepEqual(currentPayments.map(item => item.payment.status), ['paid', 'unpaid']);
  assert.deepEqual(
    currentPayments.map(item => item.paymentInformationDelivery.status),
    ['not_sent', 'not_sent']
  );
});

test('payment ledger rejects invalid status, amount, currency, and enrollment dates', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'student-payment-invalid-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const ledger = createStudentPaymentLedger(path.join(directory, 'ledger.json'));
  const input = {
    enrolledAt: '2026-01-01T00:00:00.000Z',
    reviewedAt: '2026-01-02T00:00:00.000Z'
  };

  assert.throws(() => ledger.setStatus('student', { ...input, status: 'verified' }), /Payment status/);
  assert.throws(() => ledger.setStatus('student', { ...input, status: 'paid', amount: -1 }), /Payment amount/);
  assert.throws(() => ledger.setStatus('student', { ...input, status: 'paid', currency: 'dollars' }), /Currency/);
  assert.throws(() => ledger.setStatus('student', { ...input, enrolledAt: 'not-a-date', status: 'paid' }), /enrollment date/);
});
