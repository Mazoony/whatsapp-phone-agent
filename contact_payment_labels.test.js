import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  applyWhatsAppPaidLabel,
  createContactPaymentLabelsStore,
  isExplicitPaidClaim,
  PAID_WHATSAPP_LABEL_ID
} from './contact_payment_labels.js';

test('paid claims require an explicit completed payment statement', () => {
  for (const text of [
    'I paid the fees.',
    "I've paid.",
    'Paid.',
    'I have already paid.',
    'We sent the payment.',
    'Payment completed.',
    'أنا دفعت الرسوم.',
    'حولت ليك المبلغ',
    'تم التحويل'
  ]) {
    assert.equal(isExplicitPaidClaim(text), true, text);
  }

  for (const text of [
    'I will pay tomorrow.',
    'I have not paid yet.',
    'Did I pay?',
    'How can I pay?',
    'The receipt is attached.',
    'ما دفعت لسه',
    'هل حولت الرسوم؟'
  ]) {
    assert.equal(isExplicitPaidClaim(text), false, text);
  }
});

test('paid labels persist by phone number and track WhatsApp label application', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'contact-payment-labels-'));
  const filePath = path.join(directory, 'payment-labels.json');
  try {
    const store = createContactPaymentLabelsStore(filePath);
    const first = store.markPaid('+249 123 456789', '123456789@s.whatsapp.net');
    assert.equal(first.label, 'paid');
    assert.equal(first.source, 'student-reported');
    assert.equal(first.jid, '123456789@s.whatsapp.net');
    assert.equal(first.whatsappAppliedAt, null);
    assert.equal(store.get('249123456789').label, 'paid');

    const reapplied = store.markPaid('249123456789', '123456789@lid');
    assert.equal(reapplied.jid, '123456789@s.whatsapp.net');
    assert.equal(reapplied.reportedAt, first.reportedAt);

    const applied = store.markWhatsAppApplied('249123456789');
    assert.ok(applied.whatsappAppliedAt);
    assert.equal(store.list()['249123456789'].whatsappAppliedAt, applied.whatsappAppliedAt);
    const manualUnpaid = store.setManualStatus('249123456789', '123456789@s.whatsapp.net', 'unpaid');
    assert.equal(manualUnpaid.label, 'unpaid');
    assert.equal(manualUnpaid.source, 'manual');
    assert.equal(manualUnpaid.whatsappAction, 'remove');
    assert.equal(store.pendingActions()[0].whatsappAction, 'remove');
    const removed = store.markWhatsAppRemoved('249123456789');
    assert.equal(removed.whatsappAction, null);
    assert.equal(store.get('249123456789').label, 'unpaid');
    assert.equal(PAID_WHATSAPP_LABEL_ID, 'es-paid');
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('manual paid marks are retained as monthly payment history after status changes', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'contact-payment-history-'));
  const filePath = path.join(directory, 'payment-labels.json');
  try {
    const store = createContactPaymentLabelsStore(filePath);
    const phoneNumber = '249123456789';
    const jid = `${phoneNumber}@s.whatsapp.net`;
    const firstPayment = store.setManualStatus(phoneNumber, jid, 'paid');
    assert.equal(firstPayment.paymentHistory.length, 1);
    assert.ok(Number.isFinite(Date.parse(firstPayment.paymentHistory[0].paidAt)));
    assert.equal(firstPayment.paymentHistory[0].jid, jid);

    const unpaid = store.setManualStatus(phoneNumber, jid, 'unpaid');
    assert.equal(unpaid.paymentHistory.length, 1);
    const secondPayment = store.setManualStatus(phoneNumber, jid, 'paid');
    assert.equal(secondPayment.paymentHistory.length, 2);
    assert.deepEqual(
      secondPayment.paymentHistory.map(payment => payment.jid),
      [jid, jid]
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('legacy manual paid labels use their saved mark date in payment history', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'contact-payment-legacy-history-'));
  const filePath = path.join(directory, 'payment-labels.json');
  const reportedAt = '2026-10-16T22:33:19.819Z';
  const phoneNumber = '249123456789';
  const jid = `${phoneNumber}@s.whatsapp.net`;
  try {
    fs.writeFileSync(filePath, JSON.stringify({
      [phoneNumber]: {
        label: 'paid',
        source: 'manual',
        reportedAt,
        jid,
        whatsappAppliedAt: null,
        whatsappAction: null
      }
    }));
    const store = createContactPaymentLabelsStore(filePath);
    assert.deepEqual(store.list()[phoneNumber].paymentHistory, [{ paidAt: reportedAt, jid }]);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('WhatsApp paid label is created and associated with the chat', async () => {
  const calls = [];
  const socket = {
    async addLabel(jid, label) {
      calls.push(['create', jid, label]);
    },
    async addChatLabel(jid, labelId) {
      calls.push(['associate', jid, labelId]);
    }
  };
  await applyWhatsAppPaidLabel(socket, '249123456789@s.whatsapp.net');
  assert.deepEqual(calls, [
    ['create', '249123456789@s.whatsapp.net', {
      id: 'es-paid',
      name: 'paid',
      color: 3
    }],
    ['associate', '249123456789@s.whatsapp.net', 'es-paid']
  ]);
  await assert.rejects(() => applyWhatsAppPaidLabel({}, '249123456789@s.whatsapp.net'),
    /does not support chat labels/);
});

test('WhatsApp paid label can be removed from a chat', async () => {
  const calls = [];
  await applyWhatsAppPaidLabel({
    async removeChatLabel(jid, labelId) {
      calls.push([jid, labelId]);
    }
  }, '249123456789@s.whatsapp.net', 'remove');
  assert.deepEqual(calls, [['249123456789@s.whatsapp.net', 'es-paid']]);
});
