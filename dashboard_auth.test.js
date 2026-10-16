import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createAdminDashboardServer } from './admin_dashboard.js';
import { DashboardAuth } from './dashboard_auth.js';

function temporaryDirectory() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dashboard-auth-test-'));
}

test('dashboard password setup stores a salted hash and authenticates a session', async () => {
  const directory = temporaryDirectory();
  const authFile = path.join(directory, 'data', 'admin_auth.json');
  const auth = new DashboardAuth(authFile);
  const request = { headers: {}, socket: { remoteAddress: '127.0.0.1' } };

  try {
    assert.deepEqual(auth.status(request), { setupRequired: true, authenticated: false });
    assert.deepEqual(await auth.setup('short'), {
      ok: false,
      status: 400,
      error: 'Choose a password between 12 and 1,024 characters.'
    });
    assert.equal((await auth.setup('a-strong-dashboard-password')).ok, true);
    assert.equal(auth.status(request).setupRequired, false);

    const record = JSON.parse(fs.readFileSync(authFile, 'utf8'));
    assert.equal(record.algorithm, 'scrypt');
    assert.notEqual(record.hash, 'a-strong-dashboard-password');
    assert.equal((await auth.setup('another-strong-password')).status, 409);

    const wrongPassword = await auth.login(request, 'incorrect');
    assert.equal(wrongPassword.status, 401);
    const login = await auth.login(request, 'a-strong-dashboard-password');
    assert.equal(login.ok, true);
    const response = { setHeader: (name, value) => { response[name] = value; } };
    auth.setCookie(response, login.token, login.maxAge);
    request.headers.cookie = response['Set-Cookie'].split(';', 1)[0];
    assert.equal(auth.status(request).authenticated, true);
    auth.logout(request);
    assert.equal(auth.status(request).authenticated, false);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('dashboard login locks out repeated failed password attempts', async () => {
  const directory = temporaryDirectory();
  const authFile = path.join(directory, 'admin_auth.json');
  const auth = new DashboardAuth(authFile);
  const request = { headers: {}, socket: { remoteAddress: '127.0.0.1' } };
  try {
    await auth.setup('a-strong-dashboard-password');
    const attempts = [];
    for (let index = 0; index < 5; index += 1) {
      attempts.push(await auth.login(request, 'incorrect-password'));
    }
    assert.equal(attempts[3].status, 401);
    assert.equal(attempts[4].status, 429);
    assert.equal((await auth.login(request, 'a-strong-dashboard-password')).status, 429);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('dashboard API and event stream require a valid password session', async () => {
  const directory = temporaryDirectory();
  const authFile = path.join(directory, 'data', 'admin_auth.json');
  fs.mkdirSync(path.dirname(authFile), { recursive: true });
  const server = createAdminDashboardServer({
    authFile,
    readData: () => ({ history: {}, contacts: {}, progress: {}, lessons: {} }),
    blockedContactsFile: path.join(directory, 'data', 'blocked.json'),
    contactGenderFile: path.join(directory, 'data', 'genders.json'),
    contactSyncRequestsFile: path.join(directory, 'data', 'contact-sync.json'),
    contactSyncStatusFile: path.join(directory, 'data', 'contact-sync-status.json'),
    broadcastFiles: {
      requests: path.join(directory, 'data', 'broadcasts.json'),
      state: path.join(directory, 'data', 'broadcast-state.json')
    },
    messageRequestsFile: path.join(directory, 'data', 'messages.json'),
    agentStatusFile: path.join(directory, 'data', 'agent-status.json'),
    agentQrFile: path.join(directory, 'data', 'agent-qr.json'),
    agentLogFile: path.join(directory, 'data', 'agent.log'),
    agentMediaActivityFile: path.join(directory, 'data', 'agent-media.json'),
    broadcastMediaDirectory: path.join(directory, 'data', 'broadcast-media')
  });

  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;
    const statusUrl = `${origin}/api/admin/auth/status`;
    const apiUrl = `${origin}/api/admin/overview`;
    const unauthenticated = await fetch(apiUrl);
    assert.equal(unauthenticated.status, 401);
    assert.equal((await fetch(`${origin}/api/admin/events`)).status, 401);
    assert.equal((await fetch(origin)).status, 200);

    const csrfRejected = await fetch(`${origin}/api/admin/auth/setup`, {
      method: 'POST',
      headers: { Origin: 'http://example.com', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        password: 'a-strong-dashboard-password',
        confirmPassword: 'a-strong-dashboard-password'
      })
    });
    assert.equal(csrfRejected.status, 403);

    const setupResponse = await fetch(`${origin}/api/admin/auth/setup`, {
      method: 'POST',
      headers: { Origin: origin, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        password: 'a-strong-dashboard-password',
        confirmPassword: 'a-strong-dashboard-password'
      })
    });
    assert.equal(setupResponse.status, 201);
    assert.equal((await fetch(statusUrl)).status, 200);

    const loginResponse = await fetch(`${origin}/api/admin/auth/login`, {
      method: 'POST',
      headers: { Origin: origin, 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: 'a-strong-dashboard-password' })
    });
    assert.equal(loginResponse.status, 200);
    const cookie = loginResponse.headers.get('set-cookie');
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /SameSite=Strict/);

    const authorizedResponse = await fetch(apiUrl, { headers: { Cookie: cookie.split(';', 1)[0] } });
    assert.equal(authorizedResponse.status, 200);
    const eventResponse = await fetch(`${origin}/api/admin/events`, {
      headers: { Cookie: cookie.split(';', 1)[0] }
    });
    assert.equal(eventResponse.status, 200);
    await eventResponse.body.cancel();

    const logoutResponse = await fetch(`${origin}/api/admin/auth/logout`, {
      method: 'POST',
      headers: { Origin: origin, Cookie: cookie.split(';', 1)[0] }
    });
    assert.equal(logoutResponse.status, 200);
    assert.equal(logoutResponse.headers.get('set-cookie'), `${cookie.split('=', 1)[0]}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`);
    assert.equal((await fetch(apiUrl, { headers: { Cookie: cookie.split(';', 1)[0] } })).status, 401);
  } finally {
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
