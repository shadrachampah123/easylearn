const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const workerSource = fs.readFileSync(path.join(__dirname, '..', 'public', 'sw.js'), 'utf8');

function createWorkerHarness({ networkFetch = async () => new Response('asset'), cachedResponse = null } = {}) {
  const listeners = new Map();
  const cache = {
    added: [],
    puts: [],
    async addAll(urls) { this.added.push(...urls); },
    async put(request, response) { this.puts.push({ request, response }); },
  };
  const caches = {
    opened: [],
    deleted: [],
    async open(name) { this.opened.push(name); return cache; },
    async keys() { return ['easylearn-v1', 'other-app-cache']; },
    async delete(name) { this.deleted.push(name); return true; },
    async match() { return cachedResponse; },
  };
  const self = {
    location: { origin: 'https://school.example' },
    clients: { claim: async () => {} },
    registration: { showNotification: async () => {} },
    addEventListener(name, listener) { listeners.set(name, listener); },
    skipWaiting() {},
  };
  const context = {
    self,
    caches,
    clients: self.clients,
    fetch: networkFetch,
    URL,
    Response,
    Promise,
  };
  vm.runInNewContext(workerSource, context, { filename: 'public/sw.js' });
  return { listeners, caches, cache };
}

function publicAssetResponse(body, cacheControl) {
  const response = new Response(body, {
    status: 200,
    headers: cacheControl ? { 'Cache-Control': cacheControl } : {},
  });
  Object.defineProperty(response, 'type', { value: 'basic' });
  return response;
}

function dispatchFetch(harness, request) {
  let responsePromise;
  harness.listeners.get('fetch')({
    request,
    respondWith(promise) { responsePromise = Promise.resolve(promise); },
  });
  return responsePromise;
}

test('install precaches only the static manifest, never rendered pages', async () => {
  const harness = createWorkerHarness();
  let installPromise;
  harness.listeners.get('install')({ waitUntil(promise) { installPromise = promise; } });
  await installPromise;
  assert.deepEqual(harness.cache.added, ['/manifest.json']);
});

test('activation removes the legacy app cache but leaves unrelated caches alone', async () => {
  const harness = createWorkerHarness();
  let activatePromise;
  harness.listeners.get('activate')({ waitUntil(promise) { activatePromise = promise; } });
  await activatePromise;
  assert.deepEqual(harness.caches.deleted, ['easylearn-v1']);
});

test('navigation and application/API requests are not intercepted or cached', async () => {
  const harness = createWorkerHarness();
  const navigation = { url: 'https://school.example/dashboard', method: 'GET', mode: 'navigate' };
  assert.equal(await dispatchFetch(harness, navigation), undefined);
  const api = new Request('https://school.example/api/auth/me');
  assert.equal(await dispatchFetch(harness, api), undefined);
  assert.equal(harness.cache.puts.length, 0);
});

test('same-origin immutable Next.js assets can be cached after a successful public response', async () => {
  const harness = createWorkerHarness({
    networkFetch: async () => publicAssetResponse('javascript', 'public, max-age=31536000, immutable'),
  });
  const request = new Request('https://school.example/_next/static/chunks/app.js');
  const response = await dispatchFetch(harness, request);
  assert.equal(response.status, 200);
  assert.equal(harness.cache.puts.length, 1);
});

test('private, no-store, and non-success static responses are never cached', async (t) => {
  for (const cacheControl of ['private, max-age=60', 'no-store']) {
    await t.test(cacheControl, async () => {
      const harness = createWorkerHarness({
        networkFetch: async () => publicAssetResponse('secret-ish', cacheControl),
      });
      const request = new Request('https://school.example/_next/static/chunks/app.js');
      await dispatchFetch(harness, request);
      assert.equal(harness.cache.puts.length, 0);
    });
  }
  await t.test('HTTP 404', async () => {
    const harness = createWorkerHarness({ networkFetch: async () => new Response('missing', { status: 404 }) });
    const request = new Request('https://school.example/_next/static/chunks/missing.js');
    await dispatchFetch(harness, request);
    assert.equal(harness.cache.puts.length, 0);
  });
});

test('cross-origin assets and non-GET requests are not intercepted', async () => {
  const harness = createWorkerHarness();
  assert.equal(await dispatchFetch(harness, new Request('https://cdn.example/_next/static/app.js')), undefined);
  assert.equal(await dispatchFetch(harness, new Request('https://school.example/_next/static/app.js', { method: 'POST' })), undefined);
  assert.equal(harness.cache.puts.length, 0);
});

test('failed static asset fetches use only the static cache or return a plain 503', async () => {
  const cached = new Response('cached static asset', { status: 200 });
  const harness = createWorkerHarness({ networkFetch: async () => { throw new Error('offline'); }, cachedResponse: cached });
  const request = new Request('https://school.example/_next/static/chunks/app.js');
  assert.equal(await (await dispatchFetch(harness, request)).text(), 'cached static asset');

  const emptyCacheHarness = createWorkerHarness({ networkFetch: async () => { throw new Error('offline'); } });
  const fallback = await dispatchFetch(emptyCacheHarness, request);
  assert.equal(fallback.status, 503);
  assert.equal(await fallback.text(), 'Offline');
});
