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

const TOKEN_RESP    = { status: 200, body: { AccessToken: 'tok123', ExpiresIn: 3600 } };
const BASKET_RESP   = { status: 201, body: { Id: 42 } };
// findProduct (resolveUnitIds): SKU-1 has units szt. (id 7, primary) and op. (id 8).
const FINDPROD_RESP = { status: 200, body: { Items: [{ Id: 100, Sku: 'SKU-1', Units: [
  { Id: '7', Name: 'szt.', Primary: true }, { Id: '8', Name: 'op.', Primary: false },
] }] } };
const ITEM_RESP     = { status: 200, body: 'Basket item added.' };
const AP_RESP       = { status: 200, body: { Items: [{ Key: 'DataRealizacjiZamowienia' }, { Key: 'nr_wlasny' }] } };
// Real platform payment options (note the volatile "(0)" deferred-days suffix on the first).
const PAYMENT_RESP  = { status: 200, body: { Items: [
  { Id: 1, Name: 'Odroczony termin płatności dni (0)' },
  { Id: 2, Name: 'Przedpłata' },
  { Id: 3, Name: 'Płatność za pobraniem' },
] } };
const PATCH_RESP    = { status: 204, body: null };
const VERIFY_RESP   = { status: 200, body: { Id: 42, Items: [{ Sku: 'SKU-1', Quantity: 2 }] } };
const DELIVERY_RESP = { status: 200, body: { Items: [{ Id: 5, Name: 'Standardowa' }] } };
const ORDER_RESP    = { status: 200, body: { OrderId: 'ORD-99' } };

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
  // One ITEM_RESP per product line (BASE_INPUT has a single item).
  const items = overrides.items ?? [ITEM_RESP];
  return [
    TOKEN_RESP,
    overrides.basket   ?? BASKET_RESP,
    overrides.findprod ?? FINDPROD_RESP,
    ...items,
    overrides.ap       ?? AP_RESP,
    overrides.patch    ?? PATCH_RESP,
    overrides.verify   ?? VERIFY_RESP,
    overrides.order    ?? ORDER_RESP,
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

  // 4. PATCH carries the delivery date as a DataRealizacjiZamowienia AdditionalProperties entry
  await test('PATCH includes delivery date in AdditionalProperties when deliveryDate is set', async () => {
    const getBody = stubWithPatchCapture(fullSeq());
    const api = loadVendorApi();
    await api.placeOrderViaBasket({ ...BASE_INPUT, deliveryDate: '2026-06-20' });

    const body = getBody();
    assert.ok(body !== null, 'PATCH body was not captured');
    assert.ok(Array.isArray(body.AdditionalProperties), 'AdditionalProperties should be an array');
    const dateProp = body.AdditionalProperties.find(p => p.Key === 'DataRealizacjiZamowienia');
    assert.ok(dateProp, 'expected a DataRealizacjiZamowienia entry');
    assert.deepStrictEqual(dateProp.Values, ['2026-06-20'],
      `expected Values ['2026-06-20'], got: ${JSON.stringify(dateProp.Values)}`);
    assert.strictEqual(body.RequestedDeliveryDate, undefined, 'should NOT send a top-level RequestedDeliveryDate');
  });

  // 4a. PATCH carries the own order number as an nr_wlasny AdditionalProperties entry
  await test('PATCH includes own order number in AdditionalProperties as nr_wlasny', async () => {
    const getBody = stubWithPatchCapture(fullSeq());
    const api = loadVendorApi();
    await api.placeOrderViaBasket({ ...BASE_INPUT, ownOrderNumber: 'PO-2026-17' });

    const body = getBody();
    assert.ok(Array.isArray(body.AdditionalProperties), 'AdditionalProperties should be an array');
    const ownProp = body.AdditionalProperties.find(p => p.Key === 'nr_wlasny');
    assert.ok(ownProp, 'expected an nr_wlasny entry');
    assert.deepStrictEqual(ownProp.Values, ['PO-2026-17'],
      `expected Values ['PO-2026-17'], got: ${JSON.stringify(ownProp.Values)}`);
  });

  // 4-pay. PATCH sends the configured numeric PaymentId directly (no /api3/order/payment lookup)
  await test('PATCH sends paymentId directly without a payment lookup', async () => {
    // No PAYMENT_RESP in the sequence — a lookup would consume the wrong response and break the flow.
    const getBody = stubWithPatchCapture(fullSeq());
    const api = loadVendorApi();
    await api.placeOrderViaBasket({ ...BASE_INPUT, paymentId: 52 });

    const body = getBody();
    assert.strictEqual(body.PaymentId, 52, `expected PaymentId 52, got: ${body.PaymentId}`);
    assert.ok(!capturedCalls.some(c => c.path === '/api3/order/payment'),
      'should NOT call /api3/order/payment when paymentId is provided');
  });

  // 4b. Fallback: resolves a legacy payment *name* to PaymentId via /api3/order/payment
  await test('PATCH includes PaymentId resolved from paymentName (legacy fallback)', async () => {
    // The payment lookup happens during prepareBasket, after additionalparameters and before PATCH.
    const seq = [TOKEN_RESP, BASKET_RESP, FINDPROD_RESP, ITEM_RESP, AP_RESP, PAYMENT_RESP, PATCH_RESP, VERIFY_RESP, DELIVERY_RESP, ORDER_RESP];
    const getBody = stubWithPatchCapture(seq);
    const api = loadVendorApi();
    await api.placeOrderViaBasket({ ...BASE_INPUT, paymentName: 'Przedpłata' });

    const body = getBody();
    assert.ok(body !== null, 'PATCH body was not captured');
    assert.strictEqual(body.PaymentId, 2, `expected PaymentId 2 (Przedpłata), got: ${body.PaymentId}`);
  });

  // 4c. The stored exact name still matches when the volatile "(N)" day count changes.
  await test('PaymentId resolves when the deferred-days "(N)" count differs from the saved value', async () => {
    // Platform now reports "(7)" days; the saved setting was captured as "(0)".
    const paymentNow = { status: 200, body: { Items: [
      { Id: 1, Name: 'Odroczony termin płatności dni (7)' },
      { Id: 2, Name: 'Przedpłata' },
      { Id: 3, Name: 'Płatność za pobraniem' },
    ] } };
    const seq = [TOKEN_RESP, BASKET_RESP, FINDPROD_RESP, ITEM_RESP, AP_RESP, paymentNow, PATCH_RESP, VERIFY_RESP, DELIVERY_RESP, ORDER_RESP];
    const getBody = stubWithPatchCapture(seq);
    const api = loadVendorApi();
    await api.placeOrderViaBasket({ ...BASE_INPUT, paymentName: 'Odroczony termin płatności dni (0)' });

    const body = getBody();
    assert.strictEqual(body.PaymentId, 1, `expected PaymentId 1 (deferred) via suffix-normalized match, got: ${body.PaymentId}`);
  });

  // 4d. An exact platform option name resolves to its Id (no fuzzy/synonym mapping)
  await test('PaymentId resolves an exact platform option name', async () => {
    const seq = [TOKEN_RESP, BASKET_RESP, FINDPROD_RESP, ITEM_RESP, AP_RESP, PAYMENT_RESP, PATCH_RESP, VERIFY_RESP, DELIVERY_RESP, ORDER_RESP];
    const getBody = stubWithPatchCapture(seq);
    const api = loadVendorApi();
    await api.placeOrderViaBasket({ ...BASE_INPUT, paymentName: 'Płatność za pobraniem' });

    const body = getBody();
    assert.strictEqual(body.PaymentId, 3, `expected PaymentId 3 (Płatność za pobraniem), got: ${body.PaymentId}`);
  });

  // 4e. A colloquial value that is NOT a platform option does NOT resolve (no PaymentId set)
  await test('non-platform payment value (e.g. "Gotówka") leaves PaymentId unset', async () => {
    const seq = [TOKEN_RESP, BASKET_RESP, FINDPROD_RESP, ITEM_RESP, AP_RESP, PAYMENT_RESP, PATCH_RESP, VERIFY_RESP, DELIVERY_RESP, ORDER_RESP];
    const getBody = stubWithPatchCapture(seq);
    const api = loadVendorApi();
    await api.placeOrderViaBasket({ ...BASE_INPUT, paymentName: 'Gotówka' });

    const body = getBody();
    assert.strictEqual(body.PaymentId, undefined, `expected no PaymentId for non-matching name, got: ${body.PaymentId}`);
  });

  // 4f. Invisible-char differences (NBSP) between saved value and API option still match
  await test('PaymentId resolves when the saved value uses a non-breaking space', async () => {
    const seq = [TOKEN_RESP, BASKET_RESP, FINDPROD_RESP, ITEM_RESP, AP_RESP, PAYMENT_RESP, PATCH_RESP, VERIFY_RESP, DELIVERY_RESP, ORDER_RESP];
    const getBody = stubWithPatchCapture(seq);
    const api = loadVendorApi();
    // Saved value has a NBSP ( ) where the API option has a regular space.
    await api.placeOrderViaBasket({ ...BASE_INPUT, paymentName: 'Płatność za pobraniem' });

    const body = getBody();
    assert.strictEqual(body.PaymentId, 3, `expected PaymentId 3 despite NBSP, got: ${body.PaymentId}`);
  });

  // 5. Each product is added via POST /api3/basket/{id}/item (not via Lines in create/PATCH)
  await test('products are added via the basket item endpoint', async () => {
    let itemBody = null;
    stubHttps(fullSeq());
    const inner = https.request;
    https.request = (options, callback) => {
      const req = inner(options, callback);
      if (options.method === 'POST' && /^\/api3\/basket\/42\/item$/.test(options.path)) {
        const origWrite = req.write.bind(req);
        req.write = (data) => { itemBody = JSON.parse(data); return origWrite(data); };
      }
      return req;
    };
    const api = loadVendorApi();
    await api.placeOrderViaBasket(BASE_INPUT);

    const itemCall = capturedCalls.find(c => c.method === 'POST' && c.path === '/api3/basket/42/item');
    assert.ok(itemCall, 'POST /api3/basket/42/item call not found');
    assert.ok(itemBody !== null, 'item body not captured');
    assert.strictEqual(itemBody.ProductKey.KeyType, 'Sku');
    assert.strictEqual(itemBody.ProductKey.Key, 'SKU-1');
    assert.strictEqual(itemBody.Quantity, '2', 'quantity should be the stringified line quantity');
    assert.strictEqual(itemBody.UnitId, '7', 'UnitId should be resolved from findProduct, matching the "szt." unit');
  });

  // 6. Finalization POSTs to /api3/basket/{id}/finalize (no /api3/order, no delivery lookup)
  await test('finalization uses POST /api3/basket/{id}/finalize', async () => {
    stubHttps(fullSeq());
    const api = loadVendorApi();
    const result = await api.placeOrderViaBasket(BASE_INPUT);

    const finalizeCall = capturedCalls.find(c => c.method === 'POST' && c.path === '/api3/basket/42/finalize');
    assert.ok(finalizeCall, 'POST /api3/basket/42/finalize not called');
    assert.ok(!capturedCalls.some(c => c.path === '/api3/order'), 'should NOT call the old /api3/order endpoint');
    assert.ok(!capturedCalls.some(c => c.path.startsWith('/api3/order/delivery')), 'should NOT look up delivery options');
    assert.strictEqual(result.OrderId, 'ORD-99', 'should return the finalize response');
  });

  // 6b. The finalize request body is empty (the basket already carries everything)
  await test('finalize sends an empty body', async () => {
    let finalizeBody = 'NOT_CAPTURED';
    stubHttps(fullSeq());
    const inner = https.request;
    https.request = (options, callback) => {
      const req = inner(options, callback);
      if (options.method === 'POST' && options.path === '/api3/basket/42/finalize') {
        const w = req.write.bind(req); req.write = d => { finalizeBody = JSON.parse(d); return w(d); };
      }
      return req;
    };
    const api = loadVendorApi();
    await api.placeOrderViaBasket(BASE_INPUT);

    assert.deepStrictEqual(finalizeBody, {}, `finalize body should be {}, got ${JSON.stringify(finalizeBody)}`);
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
    stubHttps([TOKEN_RESP, BASKET_RESP, FINDPROD_RESP, ITEM_RESP, AP_RESP, { status: 422, body: { Message: 'Validation failed' } }]);
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
    stubHttps([TOKEN_RESP, BASKET_RESP, FINDPROD_RESP, ITEM_RESP, { status: 404, body: null }, PATCH_RESP, VERIFY_RESP, ORDER_RESP]);
    const api = loadVendorApi();
    const result = await api.placeOrderViaBasket(BASE_INPUT);
    assert.strictEqual(result.OrderId, 'ORD-99',
      'expected order to complete despite additionalparameters 404');
  });

  // 10. updateBasket clears existing items, re-adds order lines, PATCHes — same basket ID
  await test('updateBasket clears items, re-adds lines, and PATCHes the same basket', async () => {
    const BASKET_WITH_ITEMS = { status: 200, body: { Id: 42, Items: [{ Sku: 'SKU-OLD' }, { Sku: 'SKU-1' }] } };
    const DELETE_RESP = { status: 200, body: 'Basket item deleted.' };
    // token → GET basket (read items) → DELETE x2 → findProduct → POST item → AP → PATCH → verify
    const seq = [TOKEN_RESP, BASKET_WITH_ITEMS, DELETE_RESP, DELETE_RESP, FINDPROD_RESP, ITEM_RESP, AP_RESP, PATCH_RESP, VERIFY_RESP];
    stubHttps(seq);

    let deletedKeys = [];
    let postedItem = null;
    const inner = https.request;
    https.request = (options, callback) => {
      const req = inner(options, callback);
      if (options.method === 'DELETE' && /\/api3\/basket\/42\/item$/.test(options.path)) {
        const w = req.write.bind(req); req.write = d => { deletedKeys.push(JSON.parse(d)); return w(d); };
      }
      if (options.method === 'POST' && /\/api3\/basket\/42\/item$/.test(options.path)) {
        const w = req.write.bind(req); req.write = d => { postedItem = JSON.parse(d); return w(d); };
      }
      return req;
    };

    const api = loadVendorApi();
    const returnedId = await api.updateBasket({ basketId: 42, ...BASE_INPUT, paymentId: 52 });

    assert.strictEqual(returnedId, 42, 'updateBasket should keep and return the same basket ID');
    // Read current contents
    assert.ok(capturedCalls.some(c => c.method === 'GET' && c.path === '/api3/basket/42'), 'should GET the basket to read items');
    // Both existing lines removed
    assert.strictEqual(deletedKeys.length, 2, `expected 2 DELETE item calls, got ${deletedKeys.length}`);
    assert.deepStrictEqual(deletedKeys.map(k => k.Key).sort(), ['SKU-1', 'SKU-OLD']);
    assert.ok(deletedKeys.every(k => k.KeyType === 'Sku'), 'delete keys should use KeyType Sku');
    // Current order line re-added
    assert.ok(postedItem, 'should POST the current order line');
    assert.strictEqual(postedItem.ProductKey.Key, 'SKU-1');
    assert.strictEqual(postedItem.UnitId, '7');
    // No create call
    assert.ok(!capturedCalls.some(c => c.method === 'POST' && c.path === '/api3/basket'),
      'updateBasket must NOT create a new basket');
  });

  // 11. updateBasket requires a basket ID
  await test('updateBasket throws without a basketId', async () => {
    stubHttps([TOKEN_RESP]);
    const api = loadVendorApi();
    await assert.rejects(
      () => api.updateBasket({ ...BASE_INPUT }),
      e => { assert.ok(/Brak ID koszyka/.test(e.message), `unexpected: ${e.message}`); return true; }
    );
  });

  // 12. getOrderStatus reads the order document and maps Status/Paid/B2BId
  await test('getOrderStatus fetches /api3/document and maps the fields', async () => {
    const DOC_RESP = { status: 200, body: { Id: 'd1', Status: '2. Gotowa do druku', Paid: false, B2BId: 12345, Type: 'Order', Name: 'ZAM/1' } };
    stubHttps([TOKEN_RESP, DOC_RESP]);
    const api = loadVendorApi();
    const info = await api.getOrderStatus(12345, { clientId: '1', apiKey: 'key' });

    const docCall = capturedCalls.find(c => c.method === 'GET' && c.path.startsWith('/api3/document'));
    assert.ok(docCall, 'should GET /api3/document');
    assert.ok(docCall.path.includes('key=12345'), `expected key=12345 in path, got ${docCall.path}`);
    assert.strictEqual(info.status, '2. Gotowa do druku');
    assert.strictEqual(info.paid, false);
    assert.strictEqual(info.b2bId, 12345);
  });

  // 13. getOrderStatus throws without an order key
  await test('getOrderStatus throws when orderKey is missing', async () => {
    stubHttps([TOKEN_RESP]);
    const api = loadVendorApi();
    await assert.rejects(
      () => api.getOrderStatus('', { clientId: '1', apiKey: 'key' }),
      e => { assert.ok(/Brak numeru zamówienia/.test(e.message), `unexpected: ${e.message}`); return true; }
    );
  });

  // 14. BasketFinalizationProblem maps to an actionable minimum-order-value hint
  await test('finalize maps BasketFinalizationProblem to a helpful message', async () => {
    const FINAL_PROBLEM = { status: 400, body: { Items: [{ ContextId: '42', ContextIdName: 'BasketId', ErrorCode: 'BasketFinalizationProblem', Error: '' }] } };
    stubHttps([TOKEN_RESP, BASKET_RESP, FINDPROD_RESP, ITEM_RESP, AP_RESP, PATCH_RESP, VERIFY_RESP, FINAL_PROBLEM]);
    const api = loadVendorApi();
    await assert.rejects(
      () => api.placeOrderViaBasket(BASE_INPUT),
      e => { assert.ok(/minimaln/i.test(e.message), `expected min-order hint, got: ${e.message}`); return true; }
    );
  });

  // ── Results ──────────────────────────────────────────────────────────────────
  console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);

})();
