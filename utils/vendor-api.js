'use strict';
const https = require('https');
const crypto = require('crypto');

const API_HOST = 'b2b.intermlecz.pl';

// Token cache keyed by "clientId:apiKey" so each location gets its own token
const tokenCache = new Map();

function utcTimestamp() {
  return new Date().toISOString().replace('T', ' ').substring(0, 19);
}

function apiRequest(path, method, body, token) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const options = {
      hostname: API_HOST,
      path,
      method: method || 'GET',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        ...(token ? { 'Authorization': 'bearer ' + token } : {}),
        ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
      },
    };
    const req = https.request(options, res => {
      let raw = '';
      res.on('data', chunk => { raw += chunk; });
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, body: raw ? JSON.parse(raw) : null });
        } catch {
          resolve({ status: res.statusCode, body: raw });
        }
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

async function getToken(clientId, apiKey) {
  const cacheKey = `${clientId}:${apiKey}`;
  const cached = tokenCache.get(cacheKey);
  if (cached && Date.now() < cached.expiresAt) return cached.token;

  const timestamp = utcTimestamp();
  const hash = crypto.createHash('md5')
    .update(String(apiKey) + timestamp + String(clientId))
    .digest('hex');

  const resp = await apiRequest('/api3/token', 'POST', {
    Hash: hash,
    ClientId: parseInt(clientId, 10),
    Timestamp: timestamp,
  });

  if (resp.status !== 200 || !resp.body?.AccessToken) {
    throw new Error(`Vendor API auth failed: ${JSON.stringify(resp.body)}`);
  }

  const token = resp.body.AccessToken;
  tokenCache.set(cacheKey, {
    token,
    expiresAt: Date.now() + (resp.body.ExpiresIn - 60) * 1000,
  });
  return token;
}

const PRODUCT_FIELDS = 'Id,Name,Sku,Unit,PriceAfterDiscountNet,RetailPriceNet,RetailPriceGross,Vat,Qty,InStock';

function buildFindProductUrl(params) {
  // Build query string manually — commas in 'field' must stay literal (not %2C)
  const parts = Object.entries(params)
    .filter(([, v]) => v !== null && v !== undefined && v !== '')
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v).replace(/%2C/gi, ',')}`);
  return `/api3/product/findProduct?${parts.join('&')}`;
}

async function searchProducts(phrase, limit = 20, creds = {}) {
  const { clientId, apiKey } = creds;
  if (!clientId || !apiKey) throw new Error('Brak danych uwierzytelniających dostawcy dla tej lokalizacji.');
  const token = await getToken(clientId, apiKey);
  const url = buildFindProductUrl({ field: PRODUCT_FIELDS, where: phrase || '' });
  const resp = await apiRequest(url, 'GET', null, token);
  if (resp.status !== 200) throw new Error(`Vendor search failed: ${resp.status} — ${JSON.stringify(resp.body)}`);
  const items = (resp.body?.Items || []).slice(0, limit);
  return { items, total: resp.body?.TotalCount || items.length };
}

async function getProductsBySku(skus, creds = {}) {
  if (!skus || skus.length === 0) return [];
  const { clientId, apiKey } = creds;
  if (!clientId || !apiKey) throw new Error('Brak danych uwierzytelniających dostawcy dla tej lokalizacji.');
  const token = await getToken(clientId, apiKey);
  const results = [];
  for (const sku of skus) {
    const url = buildFindProductUrl({ field: PRODUCT_FIELDS, productsSku: String(sku).trim() });
    const resp = await apiRequest(url, 'GET', null, token);
    if (resp.status !== 200) { console.error(`[vendor-api] SKU ${sku} lookup failed: ${resp.status}`); continue; }
    const match = (resp.body?.Items || []).find(p => String(p.Sku).trim() === String(sku).trim());
    if (match) results.push(match);
  }
  return results;
}

// Steps 1-4: create basket, fetch additional parameters, PATCH, add product lines.
// Returns the basket ID so it can be inspected on the B2B platform before finalization.
async function prepareBasket({ items, comment, clientId, apiKey, paymentName, address, addressId, deliveryDate }) {
  if (!clientId || !apiKey) throw new Error('Brak danych uwierzytelniających dostawcy dla tej lokalizacji.');

  const token = await getToken(clientId, apiKey);

  const lines = items
    .filter(i => i.vendor_product_key)
    .map(i => {
      const line = { KeyType: 'Sku', Key: String(i.vendor_product_key), Quantity: Number(i.quantity) };
      if (i.unit) line.UnitId = String(i.unit);
      return line;
    });

  if (lines.length === 0) throw new Error('Brak produktów z kluczem SKU dostawcy.');

  // Step 1: Create basket — include lines in creation body (same pattern as /api3/order).
  // Address and delivery date are applied via PATCH afterward so they can be confirmed
  // against the additionalparameters the API reports for this basket.
  const ts = new Date().toISOString().replace('T', ' ').substring(0, 16);
  const basketBody = { BasketName: `${comment || 'Zamówienie'} (${ts})` };
  if (paymentName) basketBody.PaymentName = paymentName;
  if (comment) basketBody.Comment = comment;
  basketBody.Lines = lines;

  console.log('[basket] POST /api3/basket:', JSON.stringify(basketBody, null, 2));
  const createResp = await apiRequest('/api3/basket', 'POST', basketBody, token);
  console.log('[basket] create response:', createResp.status, JSON.stringify(createResp.body));
  if (![200, 201].includes(createResp.status)) {
    const msg = typeof createResp.body === 'string' ? createResp.body : JSON.stringify(createResp.body);
    throw new Error(`Błąd tworzenia koszyka: ${msg}`);
  }
  const basketId = createResp.body?.Id ?? createResp.body?.BasketId ?? createResp.body?.id ?? null;
  if (!basketId) {
    console.error('[basket] create body (no ID field):', JSON.stringify(createResp.body));
    throw new Error(`Brak ID koszyka w odpowiedzi: ${JSON.stringify(createResp.body)}`);
  }
  console.log(`[basket] created basket ID: ${basketId}`);

  // Step 2: Fetch basket-specific additional parameters to learn what the API accepts
  console.log(`[basket] GET /api3/basket/${basketId}/additionalparameters`);
  let additionalParams = null;
  try {
    const apResp = await apiRequest(`/api3/basket/${basketId}/additionalparameters`, 'GET', null, token);
    console.log('[basket] additionalparameters response:', apResp.status, JSON.stringify(apResp.body));
    if ([200, 201].includes(apResp.status)) additionalParams = apResp.body;
    else console.warn(`[basket] additionalparameters returned ${apResp.status} — will PATCH with known fields`);
  } catch (e) {
    console.warn('[basket] additionalparameters fetch error:', e.message);
  }

  // Step 3: PATCH basket — set address, delivery date, and explicit Delivery: null
  const patchBody = { Delivery: null };
  if (addressId) {
    patchBody.AddressId = parseInt(addressId, 10);
  } else if (address) {
    const addr = { OneTimeAdress: true };
    if (address.Name)            addr.Name            = address.Name;
    if (address.Street)          addr.Street          = address.Street;
    if (address.City)            addr.City            = address.City;
    if (address.PostalCode)      addr.PostalCode      = address.PostalCode;
    if (address.Phone)           addr.Phone           = address.Phone;
    if (address.CountryId != null) addr.CountryId     = address.CountryId;
    if (address.RegionId  != null) addr.RegionId      = address.RegionId;
    if (address.Email)           addr.Email           = address.Email;
    if (address.ApartmentNumber) addr.ApartmentNumber = address.ApartmentNumber;
    if (address.HouseNumber)     addr.HouseNumber     = address.HouseNumber;
    if (address.TaxNumber)       addr.TaxNumber       = address.TaxNumber;
    patchBody.Address = addr;
  }
  if (deliveryDate) {
    const dateField = _resolveAdditionalParamName(additionalParams, ['RequestedDeliveryDate', 'DeliveryDate'], 'RequestedDeliveryDate');
    patchBody[dateField] = deliveryDate;
    console.log(`[basket] mapping deliveryDate → ${dateField}: ${deliveryDate}`);
  }

  console.log(`[basket] PATCH /api3/basket/${basketId}:`, JSON.stringify(patchBody, null, 2));
  const patchResp = await apiRequest(`/api3/basket/${basketId}`, 'PATCH', patchBody, token);
  console.log('[basket] PATCH response:', patchResp.status, JSON.stringify(patchResp.body));
  if (![200, 201, 204].includes(patchResp.status)) {
    const msg = typeof patchResp.body === 'string' ? patchResp.body : JSON.stringify(patchResp.body);
    throw new Error(`Błąd aktualizacji koszyka: ${msg}`);
  }

  return basketId;
}

// Step 5: Finalize an existing open basket into an order.
async function finalizeBasket({ basketId, clientId, apiKey }) {
  if (!clientId || !apiKey) throw new Error('Brak danych uwierzytelniających dostawcy dla tej lokalizacji.');
  const token = await getToken(clientId, apiKey);

  console.log(`[basket] POST /api3/basket/${basketId}/order`);
  const orderResp = await apiRequest(`/api3/basket/${basketId}/order`, 'POST', {}, token);
  console.log('[basket] finalize response:', orderResp.status, JSON.stringify(orderResp.body));
  if (![200, 201].includes(orderResp.status)) {
    const msg = typeof orderResp.body === 'string' ? orderResp.body : JSON.stringify(orderResp.body);
    throw new Error(`Błąd finalizacji koszyka: ${msg}`);
  }
  const result = orderResp.body;
  console.log(`[basket] created order ID: ${result?.OrderId || result?.Id || '(unknown)'}`);
  return result;
}

// Convenience wrapper: prepare then immediately finalize (single-step flow).
async function placeOrderViaBasket(opts) {
  const basketId = await prepareBasket(opts);
  return finalizeBasket({ basketId, clientId: opts.clientId, apiKey: opts.apiKey });
}

// Looks for a parameter name in the additionalparameters API response, falling back to defaultName.
// candidateNames is checked in priority order against Items[].Name (case-insensitive).
function _resolveAdditionalParamName(additionalParams, candidateNames, defaultName) {
  const items = additionalParams?.Items || additionalParams?.AdditionalParameters || [];
  for (const candidate of candidateNames) {
    if (items.some(p => String(p.Name).toLowerCase() === candidate.toLowerCase())) {
      return candidate;
    }
  }
  return defaultName;
}

async function getDeliveryOptions(creds = {}, addressId = null) {
  const { clientId, apiKey } = creds;
  if (!clientId || !apiKey) throw new Error('Brak danych uwierzytelniających dostawcy.');
  const token = await getToken(clientId, apiKey);
  const path = '/api3/order/delivery' + (addressId ? `?AddressId=${encodeURIComponent(addressId)}` : '');
  const resp = await apiRequest(path, 'GET', null, token);
  if (resp.status !== 200) {
    throw new Error(`Delivery API error: ${resp.status} — ${JSON.stringify(resp.body)}`);
  }
  return resp.body?.Items || [];
}

async function getClientAddresses(creds = {}) {
  const { clientId, apiKey } = creds;
  if (!clientId || !apiKey) throw new Error('Brak danych uwierzytelniających dostawcy.');
  const token = await getToken(clientId, apiKey);
  const resp = await apiRequest('/api3/address/clientAddress', 'GET', null, token);
  if (resp.status !== 200) {
    throw new Error(`Address API error: ${resp.status} — ${JSON.stringify(resp.body)}`);
  }
  return resp.body?.Items || [];
}

module.exports = { getToken, searchProducts, getProductsBySku, prepareBasket, finalizeBasket, placeOrderViaBasket, getDeliveryOptions, getClientAddresses };
