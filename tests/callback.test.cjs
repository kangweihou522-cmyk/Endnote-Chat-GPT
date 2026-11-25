const { test } = require('node:test');
const assert = require('node:assert/strict');
const { openCallback, officialRequest } = require('../src/chatgpt.cjs');

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
    assert.match(response.headers.get('content-security-policy'), /script-src 'nonce-/);
    const receipt = await response.text();
    assert.match(receipt, /replaceState\(null, "", "\/auth\/received"\)/);
    assert.doesNotMatch(receipt, /test-code|expected-test-state/);
    assert.equal(await callback.result, returned);
  } finally { callback.close(); }
});

test('ChatGPT HTTP keeps explicit credentials out of browser state and identifies a blocked webpage', async () => {
  const result = await officialRequest(async (url, options) => {
    assert.equal(url, 'https://api.openai.com/v1/models');
    assert.equal(options.headers.Authorization, 'Bearer test-token');
    assert.equal(options.redirect, 'error');
    assert.equal(options.credentials, 'omit');
    return new Response('<html>Blocked</html>', {
      status: 403, headers: { 'content-type': 'text/html; charset=utf-8', 'x-request-id': 'req_test' }
    });
  }, { url: 'https://api.openai.com/v1/models', headers: { Authorization: 'Bearer test-token' } });
  assert.deepEqual(result, {
    status: 403, text: '<html>Blocked</html>', webpage: true, requestId: 'req_test'
  });
});

test('cancelling a native login closes the loopback and rejects the pending authorization', async () => {
  const cancel = new AbortController();
  const callback = await openCallback({ state: 'expected-test-state', signal: cancel.signal, timeoutMs: 10000 });
  cancel.abort();
  await assert.rejects(callback.result, /已取消/);
  await assert.rejects(fetch(callback.redirectUri));
});
