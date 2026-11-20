import test from 'node:test';
import assert from 'node:assert/strict';

// Env must be set before server.js is imported (it reads config at load time).
process.env.APP_VERSION = '9.9.9';
process.env.POD_NAME = 'test-pod';
process.env.CHAOS_ENABLED = 'true';
process.env.API_TOKEN = 'super-secret';

const { default: server } = await import('../server.js');

test('KubePulse app contract', async (t) => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (p, init) => {
    const res = await fetch(base + p, init);
    const type = res.headers.get('content-type') || '';
    return { res, body: type.includes('json') ? await res.json() : await res.text() };
  };

  await t.test('/healthz (liveness) is always 200', async () => {
    assert.equal((await call('/healthz')).res.status, 200);
  });

  await t.test('/api/info reports pod, version, student; never leaks the secret', async () => {
    const { res, body } = await call('/api/info');
    assert.equal(res.headers.get('x-served-by'), 'test-pod');
    assert.equal(body.pod, 'test-pod');
    assert.equal(body.version, '9.9.9');
    assert.equal(body.student.regNo, '2547105');
    assert.equal(body.secretConfigured, true);
    assert.ok(!JSON.stringify(body).includes('super-secret'));
  });

  await t.test('/readyz (readiness) follows the chaos switch', async () => {
    assert.equal((await call('/readyz')).res.status, 200);
    assert.equal((await call('/api/chaos/unready', { method: 'POST' })).res.status, 200);
    assert.equal((await call('/readyz')).res.status, 503);
    await call('/api/chaos/ready', { method: 'POST' });
    assert.equal((await call('/readyz')).res.status, 200);
  });

  await t.test('chaos endpoints reject GET', async () => {
    assert.equal((await call('/api/chaos/unready')).res.status, 405);
  });

  await t.test('/api/load burns CPU but caps the duration', async () => {
    const { body } = await call('/api/load?ms=999999');
    assert.equal(body.burnedMs, 2000);
  });

  await t.test('dashboard served and path traversal blocked', async () => {
    const page = await call('/');
    assert.equal(page.res.status, 200);
    assert.match(page.body, /KubePulse/);
    // fetch normalises ../ in URLs, so send an encoded traversal.
    assert.notEqual((await call('/%2e%2e/package.json')).res.status, 200);
  });

  server.close();
});
