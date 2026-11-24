const { test } = require('node:test');
const assert = require('node:assert/strict');
const { openCallback } = require('../src/chatgpt.cjs');

test('the native callback binds loopback and ignores a forged state before accepting the browser', async () => {
  const callback = await openCallback({ state: 'expected-test-state', timeoutMs: 10000 });
  try {
    assert.match(callback.redirectUri, /^http:\/\/127\.0\.0\.1:\d+\/auth\/callback$/);
    const bad = await fetch(callback.redirectUri + '?state=bad-state&code=test-code');
    assert.equal(bad.status, 400);
    const returned = callback.redirectUri + '?state=expected-test-state&code=test-code';
    const response = await fetch(returned);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(await callback.result, returned);
  } finally { callback.close(); }
});

test('cancelling a native login closes the loopback and rejects the pending authorization', async () => {
  const cancel = new AbortController();
  const callback = await openCallback({ state: 'expected-test-state', signal: cancel.signal, timeoutMs: 10000 });
  cancel.abort();
  await assert.rejects(callback.result, /已取消/);
  await assert.rejects(fetch(callback.redirectUri));
});
