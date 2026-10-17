import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  clearAgentQr,
  consumeAgentControlRequest,
  consumeAgentDisconnectRequest,
  readAgentQr,
  readLastAgentAccount,
  readLastConnectedAt,
  renderAgentQrSvg,
  requestAgentDisconnect,
  requestAgentResponseMode,
  writeAgentQr,
  writeAgentStatus
} from './agent_status.js';

test('agent status retains a valid last-connection timestamp', () => {
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-status-test-'));
  const statusFile = path.join(temporaryDirectory, 'agent_status.json');
  const lastConnectedAt = '2026-10-15T10:00:00.000Z';
  const account = { name: 'WhatsApp User', phoneNumber: '249123456789' };

  try {
    assert.equal(readLastConnectedAt(statusFile), null);
    writeAgentStatus('connecting', lastConnectedAt, account, statusFile);
    assert.equal(readLastConnectedAt(statusFile), lastConnectedAt);
    assert.deepEqual(readLastAgentAccount(statusFile), account);

    fs.writeFileSync(statusFile, JSON.stringify({ lastConnectedAt: 'not-a-date' }));
    assert.equal(readLastConnectedAt(statusFile), null);
    assert.equal(readLastAgentAccount(statusFile), null);

    fs.writeFileSync(statusFile, JSON.stringify({
      account: { name: 'Invalid', phoneNumber: 'not-a-number' }
    }));
    assert.equal(readLastAgentAccount(statusFile), null);
  } finally {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});

test('dashboard disconnect request can be consumed once by the agent', () => {
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-control-test-'));
  const controlFile = path.join(temporaryDirectory, 'agent_control.json');

  try {
    assert.equal(consumeAgentDisconnectRequest(controlFile), false);
    const request = requestAgentDisconnect(controlFile);
    assert.deepEqual(JSON.parse(fs.readFileSync(controlFile, 'utf8')), request);
    assert.equal(consumeAgentDisconnectRequest(controlFile), true);
    assert.equal(consumeAgentDisconnectRequest(controlFile), false);
  } finally {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});

test('dashboard reply-mode requests are validated and can be consumed once', () => {
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-reply-mode-test-'));
  const controlFile = path.join(temporaryDirectory, 'agent_control.json');

  try {
    assert.throws(() => requestAgentResponseMode('yes', controlFile), TypeError);
    assert.equal(requestAgentResponseMode(false, controlFile).action, 'pause_replies');
    assert.equal(consumeAgentControlRequest(controlFile), 'pause_replies');
    assert.equal(requestAgentResponseMode(true, controlFile).action, 'resume_replies');
    assert.equal(consumeAgentControlRequest(controlFile), 'resume_replies');
  } finally {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});

test('agent status surfaces malformed persisted JSON', () => {
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-status-test-'));
  const statusFile = path.join(temporaryDirectory, 'agent_status.json');

  try {
    fs.writeFileSync(statusFile, '{');
    assert.throws(() => readLastConnectedAt(statusFile), SyntaxError);
    assert.throws(() => readLastAgentAccount(statusFile), SyntaxError);
  } finally {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});

test('pairing QR is available briefly, renders as SVG, and can be cleared', () => {
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-qr-test-'));
  const qrFile = path.join(temporaryDirectory, 'agent_qr.json');

  try {
    assert.equal(readAgentQr(qrFile), null);
    const qr = writeAgentQr('whatsapp-pairing-token', qrFile);
    assert.deepEqual(readAgentQr(qrFile), qr);
    const svg = renderAgentQrSvg(qr.value);
    assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
    assert.match(svg, /<path d="M/);
    assert.equal(readAgentQr(qrFile, Date.parse(qr.updatedAt) + 60_001), null);
    clearAgentQr(qrFile);
    assert.equal(readAgentQr(qrFile), null);
  } finally {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});
