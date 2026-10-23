import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  createStudentPaymentLedger,
  formatStudentPaymentStatus,
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

test('rolling payment periods begin at enrollment and advance every 30 days', () => {
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
