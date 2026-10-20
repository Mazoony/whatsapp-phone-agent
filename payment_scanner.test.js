import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildPaymentScanPrompt,
  parsePaymentScanResult,
  scanPaymentReceipt,
  formatPaymentAcknowledgment
} from './payment_scanner.js';

test('buildPaymentScanPrompt formats caption correctly or omits placeholder', () => {
  const promptWithCaption = buildPaymentScanPrompt('حولتها من بنكك');
  assert.ok(promptWithCaption.includes('حولتها من بنكك'));

  const promptWithPlaceholder = buildPaymentScanPrompt('أرسل صورة');
  assert.ok(!promptWithPlaceholder.includes('أرسل صورة'));

  const promptEmpty = buildPaymentScanPrompt('');
  assert.ok(!promptEmpty.includes('caption'));
});

test('parsePaymentScanResult parses valid payment receipts with details', () => {
  const rawJson = JSON.stringify({
    isPayment: true,
    confidence: 0.95,
    details: {
      bank: 'Bank of Khartoum (Bankak)',
      amount: 17000,
      currency: 'SDG',
      transactionId: 'TXN-987654321',
      recipientName: 'Mazen Mohammed Ahmed',
      recipientAccount: '2865022',
      date: '2026-10-20'
    },
    reason: 'Bankak transfer screenshot showing 17,000 SDG sent to Mazen Mohammed'
  });

  const result = parsePaymentScanResult(rawJson);
  assert.equal(result.isPayment, true);
  assert.equal(result.confidence, 0.95);
  assert.equal(result.details.bank, 'Bank of Khartoum (Bankak)');
  assert.equal(result.details.amount, 17000);
  assert.equal(result.details.currency, 'SDG');
  assert.equal(result.details.transactionId, 'TXN-987654321');
  assert.equal(result.details.recipientAccount, '2865022');
});

test('parsePaymentScanResult cleans markdown code fences and normalizes numeric strings', () => {
  const rawWithFences = `\`\`\`json
{
  "isPayment": true,
  "confidence": 0.99,
  "details": {
    "bank": "بنك الخرطوم",
    "amount": "27,000",
    "currency": "SDG",
    "transactionId": 12345678,
    "recipientName": "مازن محمد",
    "recipientAccount": 2865022,
    "date": "2026-10-19"
  },
  "reason": "عملية تحويل بنكك مكتملة بمبلغ 27000"
}
\`\`\``;

  const result = parsePaymentScanResult(rawWithFences);
  assert.equal(result.isPayment, true);
  assert.equal(result.details.amount, 27000);
  assert.equal(result.details.transactionId, '12345678');
  assert.equal(result.details.recipientAccount, '2865022');
});

test('parsePaymentScanResult correctly handles non-payment images (homework, books, photos)', () => {
  const homeworkResult = parsePaymentScanResult(JSON.stringify({
    isPayment: false,
    confidence: 0.98,
    details: null,
    reason: 'Handwritten English homework answers in a notebook'
  }));
  assert.equal(homeworkResult.isPayment, false);
  assert.equal(homeworkResult.details, null);
  assert.ok(homeworkResult.reason.includes('homework'));

  const bookResult = parsePaymentScanResult(JSON.stringify({
    isPayment: false,
    confidence: 0.95,
    details: null,
    reason: 'Textbook page from Spine 6'
  }));
  assert.equal(bookResult.isPayment, false);
  assert.equal(bookResult.details, null);
});

test('parsePaymentScanResult rejects malformed or invalid schemas', () => {
  assert.throws(() => parsePaymentScanResult('not a json string'), /Invalid JSON/);
  assert.throws(() => parsePaymentScanResult('{"foo": "bar"}'), /missing isPayment boolean/);
});

test('scanPaymentReceipt returns isPayment=false when no images are provided', async () => {
  const result = await scanPaymentReceipt([]);
  assert.equal(result.isPayment, false);
  assert.equal(result.reason, 'No images provided');
});

test('scanPaymentReceipt uses generateContent hook when provided', async () => {
  const dummyImage = { data: Buffer.from('fake-image-bytes'), mimeType: 'image/jpeg' };
  const mockResult = await scanPaymentReceipt([dummyImage], 'إيصال التحويل', {
    generateContent: async (images, caption) => {
      assert.equal(images.length, 1);
      assert.equal(caption, 'إيصال التحويل');
      return JSON.stringify({
        isPayment: true,
        confidence: 0.97,
        details: {
          bank: 'Bank of Khartoum',
          amount: 17000,
          currency: 'SDG',
          transactionId: 'REF-001',
          recipientName: 'مازن محمد',
          recipientAccount: '2865022',
          date: '2026-10-20'
        },
        reason: 'Valid Bankak receipt'
      });
    }
  });

  assert.equal(mockResult.isPayment, true);
  assert.equal(mockResult.details.amount, 17000);
  assert.equal(mockResult.details.bank, 'Bank of Khartoum');
});

test('formatPaymentAcknowledgment provides friendly messages in Arabic and English', () => {
  const arabicAck = formatPaymentAcknowledgment({ isPayment: true }, { language: 'arabic' });
  assert.ok(arabicAck.includes('وصل إيصال التحويل'));
  assert.ok(arabicAck.includes('بارك الله فيك'));

  const englishAck = formatPaymentAcknowledgment({ isPayment: true }, { language: 'english' });
  assert.ok(englishAck.includes('Payment receipt received'));
});

test('scanned payment receipt updates payments calendar endpoint automatically', async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const { createContactPaymentLabelsStore } = await import('./contact_payment_labels.js');
  const { createAdminDashboardServer } = await import('./admin_dashboard.js');

  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'admin-scanned-payment-calendar-'));
  const paymentLabelsFile = path.join(temporaryDirectory, 'contact_payment_labels.json');
  const store = createContactPaymentLabelsStore(paymentLabelsFile);
  const phoneNumber = '249123456789';
  const jid = `${phoneNumber}@s.whatsapp.net`;

  // 1. Simulate scanned payment from photo
  const dummyImage = { data: Buffer.from('mock-payment-photo'), mimeType: 'image/jpeg' };
  const scanResult = await scanPaymentReceipt([dummyImage], 'تم التحويل في بنكك', {
    generateContent: async () => JSON.stringify({
      isPayment: true,
      confidence: 0.99,
      details: {
        bank: 'Bank of Khartoum (Bankak)',
        amount: 17000,
        currency: 'SDG',
        transactionId: 'REF-1002',
        recipientName: 'مازن محمد أحمد',
        recipientAccount: '2865022',
        date: '2026-10-20'
      },
      reason: 'Confirmed Bankak transfer'
    })
  });

  assert.equal(scanResult.isPayment, true);

  // 2. Automatically record scanned payment
  store.recordScannedPayment(phoneNumber, jid, scanResult);

  // 3. Verify admin dashboard payment-calendar endpoint reflects the payment
  const server = createAdminDashboardServer({
    readData: () => ({ history: {}, contacts: {} }),
    readContacts: () => ({
      [jid]: { name: 'Photo Payer Student' }
    }),
    paymentLabelsFile,
    authManager: { isAuthenticated: () => true }
  });

  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const response = await fetch(
      `http://127.0.0.1:${server.address().port}/api/admin/payment-calendar`
    );
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.payments.length, 1);
    assert.equal(result.payments[0].studentName, 'Photo Payer Student');
    assert.equal(result.payments[0].phoneNumber, phoneNumber);
    assert.equal(result.payments[0].source, 'payment-scan');
    assert.equal(result.payments[0].amount, 17000);
    assert.equal(result.payments[0].bank, 'Bank of Khartoum (Bankak)');
    assert.equal(result.payments[0].transactionId, 'REF-1002');
  } finally {
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});

