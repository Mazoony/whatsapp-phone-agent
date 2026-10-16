import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { appendAgentLog, readRecentAgentLogs } from './agent_runtime.js';

test('agent log records formatted terminal output and returns the latest bounded lines', () => {
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-log-test-'));
  const logFile = path.join(temporaryDirectory, 'agent.log');

  try {
    appendAgentLog('info', ['Starting agent'], logFile);
    appendAgentLog('log', ['Reply to %s: %s', 'Ali', 'Welcome'], logFile);
    appendAgentLog('error', ['First line\nSecond line'], logFile);

    const result = readRecentAgentLogs(logFile, 2);
    assert.equal(result.lines.length, 2);
    assert.match(result.lines[0], /\[error\] First line$/);
    assert.match(result.lines[1], /\[error\] Second line$/);
    assert.ok(result.updatedAt);
    assert.equal(readRecentAgentLogs(logFile, 0).lines.length, 1);
    assert.deepEqual(readRecentAgentLogs(path.join(temporaryDirectory, 'missing.log')).lines, []);
  } finally {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});

test('agent log trims oversized files after closing the source file', () => {
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-log-trim-test-'));
  const logFile = path.join(temporaryDirectory, 'agent.log');

  try {
    fs.writeFileSync(logFile, 'Older log entry\n'.repeat(100_000));
    appendAgentLog('info', ['New log entry'], logFile);
    assert.ok(fs.statSync(logFile).size < 600 * 1024);
    assert.match(readRecentAgentLogs(logFile, 1).lines[0], /\[info\] New log entry$/);
  } finally {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});
