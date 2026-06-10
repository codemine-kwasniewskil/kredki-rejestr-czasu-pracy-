'use strict';
const assert = require('assert');
const https = require('https');
const EventEmitter = require('events');

// ── Stub infrastructure ──────────────────────────────────────────────────────

let stubbedResponses = [];
let capturedCalls = [];

function stubHttps(responses) {
  stubbedResponses = [...responses];
  capturedCalls = [];

  https.request = (options, callback) => {
    const res = new EventEmitter();
    const entry = stubbedResponses.shift() ?? { status: 200, body: null };
    res.statusCode = entry.status;
    const bodyStr = entry.body !== null ? JSON.stringify(entry.body) : '';

    const req = new EventEmitter();
    req.write = () => {};
    req.end = () => {
      if (callback) callback(res);
      if (bodyStr) res.emit('data', bodyStr);
      res.emit('end');
    };

    capturedCalls.push({ path: options.path, method: options.method });
    return req;
  };
}

const realRequest = https.request;
function restoreHttps() { https.request = realRequest; }

function loadVendorApi() {
  const key = require.resolve('../utils/vendor-api');
  delete require.cache[key];
  return require('../utils/vendor-api');
}

// ── Fixtures ─────────────────────────────────────────────────────────────────

const TOKEN_RESP  = { status: 200, body: { AccessToken: 'tok123', ExpiresIn: 3600 } };
const BASKET_RESP = { status: 201, body: { Id: 42 } };
const AP_RESP     = { status: 200, body: { Items: [{ Name: 'RequestedDeliveryDate' }] } };
const PATCH_RESP  = { status: 204, body: null };
const LINE_RESP   = { status: 201, body: {} };
const ORDER_RESP  = { status: 200, body: { OrderId: 'ORD-99' } };

const BASE_INPUT = {
  items: [{ vendor_product_key: 'SKU-1', quantity: 2, unit: 'szt.' }],
  comment: 'test',
  clientId: '1',
  apiKey: 'key',
  paymentName: null,
  address: null,
  addressId: 7,
  deliveryDate: null,
};

function fullSeq(overrides = {}) {
  return [
    TOKEN_RESP,
    overrides.basket ?? BASKET_RESP,
    overrides.ap     ?? AP_RESP,
    overrides.patch  ?? PATCH_RESP,
    overrides.line   ?? LINE_RESP,
    overrides.order  ?? ORDER_RESP,
  ];
}

// ── Test runner ───────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (e) {
    console.error(`  ✗ ${name}`);
    console.error(`    ${e.message}`);
    failed++;
  } finally {
    restoreHttps();
  }
}

// ── Helper: intercept PATCH body ─────────────────────────────────────────────

function stubWithPatchCapture(responses) {
  stubHttps(responses);
  let patchBody = null;
  const inner = https.request;
  https.request = (options, callback) => {
    const req = inner(options, callback);
    if (options.method === 'PATCH') {
      const origWrite = req.write.bind(req);
      req.write = (data) => { patchBody = JSON.parse(data); return origWrite(data); };
    }
    return req;
  };
  return () => patchBody;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

(async () => {

  // 1. Basket creation is called before additional parameters fetch
  await test('basket creation is called before additional parameters fetch', async () => {
    stubHttps(fullSeq());
    const api = loadVendorApi();
    await api.placeOrderViaBasket(BASE_INPUT);

    const paths = capturedCalls.map(c => c.path);
    const basketIdx = paths.findIndex(p => p === '/api3/basket');
    const apIdx     = paths.findIndex(p => p.includes('/additionalparameters'));
    assert.ok(basketIdx !== -1, 'basket creation call not found');
    assert.ok(apIdx     !== -1, 'additionalparameters call not found');
    assert.ok(basketIdx < apIdx, 'basket creation must happen before additionalparameters fetch');
  });

  // 2. Additional parameters fetch uses the basket ID returned by creation
  await test('additional parameters fetch uses basket ID from creation response', async () => {
    stubHttps(fullSeq());
    const api = loadVendorApi();
    await api.placeOrderViaBasket(BASE_INPUT);

    const apCall = capturedCalls.find(c => c.path.includes('/additionalparameters'));
    assert.ok(apCall, 'additionalparameters call not found');
    assert.ok(apCall.path.includes('/42/') || apCall.path.endsWith('/42/additionalparameters'),
      `expected basket ID 42 in path, got: ${apCall.path}`);
  });

  // 3. PATCH is called with Delivery: null
  await test('PATCH basket is called with Delivery: null', async () => {
    const getBody = stubWithPatchCapture(fullSeq());
    const api = loadVendorApi();
    await api.placeOrderViaBasket(BASE_INPUT);

    const body = getBody();
    assert.ok(body !== null, 'PATCH body was not captured');
    assert.strictEqual(body.Delivery, null, `expected Delivery: null, got: ${body.Delivery}`);
  });

  // 4. PATCH includes RequestedDeliveryDate when deliveryDate is provided
  await test('PATCH includes RequestedDeliveryDate when deliveryDate is set', async () => {
    const getBody = stubWithPatchCapture(fullSeq());
    const api = loadVendorApi();
    await api.placeOrderViaBasket({ ...BASE_INPUT, deliveryDate: '2026-06-20' });

    const body = getBody();
    assert.ok(body !== null, 'PATCH body was not captured');
    assert.strictEqual(body.RequestedDeliveryDate, '2026-06-20',
      `expected RequestedDeliveryDate '2026-06-20', got: ${body.RequestedDeliveryDate}`);
  });

  // 5. Products are added only after PATCH succeeds
  await test('products are added only after PATCH succeeds', async () => {
    stubHttps(fullSeq());
    const api = loadVendorApi();
    await api.placeOrderViaBasket(BASE_INPUT);

    const patchIdx = capturedCalls.findIndex(c => c.method === 'PATCH');
    const lineIdx  = capturedCalls.findIndex(c => c.path.includes('/line'));
    assert.ok(patchIdx !== -1, 'PATCH call not found');
    assert.ok(lineIdx  !== -1, 'line add call not found');
    assert.ok(patchIdx < lineIdx, 'PATCH must happen before adding product lines');
  });

  // 6. Finalization uses the same basket ID
  await test('finalization uses the same basket ID', async () => {
    stubHttps(fullSeq());
    const api = loadVendorApi();
    await api.placeOrderViaBasket(BASE_INPUT);

    const finalizeCall = capturedCalls.find(
      c => c.path === '/api3/basket/42/order' && c.method === 'POST'
    );
    assert.ok(finalizeCall,
      `finalize call not found; calls: ${JSON.stringify(capturedCalls)}`);
  });

  // 7. Error on basket creation throws with Polish message
  await test('basket creation failure throws with Polish error message', async () => {
    stubHttps([TOKEN_RESP, { status: 400, body: { Message: 'Invalid basket' } }]);
    const api = loadVendorApi();
    await assert.rejects(
      () => api.placeOrderViaBasket(BASE_INPUT),
      e => {
        assert.ok(e.message.startsWith('Błąd tworzenia koszyka'),
          `unexpected message: ${e.message}`);
        return true;
      }
    );
  });

  // 8. Error on PATCH throws with Polish message
  await test('PATCH failure throws with Polish error message', async () => {
    stubHttps([TOKEN_RESP, BASKET_RESP, AP_RESP, { status: 422, body: { Message: 'Validation failed' } }]);
    const api = loadVendorApi();
    await assert.rejects(
      () => api.placeOrderViaBasket(BASE_INPUT),
      e => {
        assert.ok(e.message.startsWith('Błąd aktualizacji koszyka'),
          `unexpected message: ${e.message}`);
        return true;
      }
    );
  });

  // 9. Additional parameters 404 does not abort the flow
  await test('additional parameters 404 does not abort the flow', async () => {
    stubHttps([TOKEN_RESP, BASKET_RESP, { status: 404, body: null }, PATCH_RESP, LINE_RESP, ORDER_RESP]);
    const api = loadVendorApi();
    const result = await api.placeOrderViaBasket(BASE_INPUT);
    assert.strictEqual(result.OrderId, 'ORD-99',
      'expected order to complete despite additionalparameters 404');
  });

  // ── Results ──────────────────────────────────────────────────────────────────
  console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);

})();
