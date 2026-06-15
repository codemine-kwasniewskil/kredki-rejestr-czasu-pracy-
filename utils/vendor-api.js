'use strict';
const https = require('https');
const crypto = require('crypto');
const catalog = require('./vendor-catalog');

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

// Product search now reads from the local catalog (XML-feed-backed `vendor_products`
// table) instead of the rate-limited /api3/product/findProduct endpoint. Both take
// { locationId }; the result shape matches the old API so callers are unchanged.

async function searchProducts(phrase, limit = 30, opts = {}) {
  const { locationId } = opts;
  if (!locationId) throw new Error('Brak ID lokalizacji dla wyszukiwania produktów.');
  return catalog.searchCatalog({ locationId, phrase, limit });
}

async function getProductsBySku(skus, opts = {}) {
  if (!skus || skus.length === 0) return [];
  const { locationId } = opts;
  if (!locationId) throw new Error('Brak ID lokalizacji dla wyszukiwania produktów.');
  return catalog.getCatalogBySku({ locationId, skus });
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

  // Step 1: Create basket header only. Lines are NOT sent here — the API accepts the
  // creation request but silently drops a Lines array, leaving the basket empty on the
  // B2B platform. Products are added separately via POST /api3/basketline below.
  // Address and delivery date are applied via PATCH afterward so they can be confirmed
  // against the additionalparameters the API reports for this basket.
  const ts = new Date().toISOString().replace('T', ' ').substring(0, 16);
  const basketBody = { BasketName: `${comment || 'Zamówienie'} (${ts})` };
  if (paymentName) basketBody.PaymentName = paymentName;
  if (comment) basketBody.Comment = comment;

  console.log('[basket] POST /api3/basket:', JSON.stringify(basketBody, null, 2));
  const createResp = await apiRequest('/api3/basket', 'POST', basketBody, token);
  console.error('[basket] create response:', createResp.status, JSON.stringify(createResp.body));
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

  // Step 3: PATCH basket — set address, delivery date, ShowOnFront, and explicit Delivery: null
  const patchBody = { Delivery: null, ShowOnFront: true };
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
  console.error('[basket] PATCH response:', patchResp.status, JSON.stringify(patchResp.body));
  if (![200, 201, 204].includes(patchResp.status)) {
    const msg = typeof patchResp.body === 'string' ? patchResp.body : JSON.stringify(patchResp.body);
    throw new Error(`Błąd aktualizacji koszyka: ${msg}`);
  }

  // Step 4: Add product lines one by one via POST /api3/basketline (BasketId in body).
  // This is what actually populates the basket — sending Lines in the create body does not.
  console.log(`[basket] adding ${lines.length} lines to basketId=${basketId}`);
  for (const line of lines) {
    const lineBody = { BasketId: basketId, KeyType: line.KeyType, Key: line.Key, Quantity: line.Quantity };
    if (line.UnitId) lineBody.UnitId = line.UnitId;
    console.log('[basket] POST /api3/basketline:', JSON.stringify(lineBody));
    const lineResp = await apiRequest('/api3/basketline', 'POST', lineBody, token);
    const lineBodyRaw = typeof lineResp.body === 'string' ? lineResp.body : JSON.stringify(lineResp.body);
    const isHtml = typeof lineResp.body === 'string' && lineResp.body.trimStart().startsWith('<');
    console.error('[basket] add line response:', lineResp.status, isHtml ? '(HTML)' : lineBodyRaw);
    if (![200, 201].includes(lineResp.status)) {
      const msg = isHtml ? `HTTP ${lineResp.status} HTML — wrong endpoint path` : lineBodyRaw;
      throw new Error(`Błąd dodawania produktu ${line.Key} [basketId=${basketId}]: ${msg}`);
    }
  }

  // Step 5: Verify the basket actually contains the lines before returning it.
  try {
    const verifyResp = await apiRequest(`/api3/basket/${basketId}`, 'GET', null, token);
    const lineCount = verifyResp.body?.Lines?.length ?? verifyResp.body?.BasketLines?.length ?? null;
    console.error(`[basket] verify GET /api3/basket/${basketId}: status=${verifyResp.status} lineCount=${lineCount} (expected ${lines.length})`);
    if (lineCount != null && lineCount < lines.length) {
      console.error('[basket] WARNING: basket has fewer lines than expected — some products were not added.');
    }
  } catch (e) {
    console.warn('[basket] verify fetch error:', e.message);
  }

  return basketId;
}

// Step 5: Finalize an open basket into an order via POST /api3/order with BasketId.
// Delivery must be specified — fetches available options and picks by name or first available.
async function finalizeBasket({ basketId, clientId, apiKey, deliveryName = null }) {
  if (!clientId || !apiKey) throw new Error('Brak danych uwierzytelniających dostawcy dla tej lokalizacji.');
  const token = await getToken(clientId, apiKey);

  let deliveryId = null;
  let chosenDeliveryName = deliveryName;
  try {
    const delResp = await apiRequest('/api3/order/delivery', 'GET', null, token);
    console.log('[basket] delivery options:', delResp.status, JSON.stringify(delResp.body));
    const opts = (delResp.body?.Items || []).filter(d => d.Name);
    if (opts.length > 0) {
      const chosen = (deliveryName && opts.find(d => d.Name === deliveryName)) || opts[0];
      deliveryId = chosen.Id ?? null;
      chosenDeliveryName = chosen.Name || deliveryName;
      console.log(`[basket] chosen delivery: id=${deliveryId} name=${chosenDeliveryName}`);
    } else {
      console.warn('[basket] no delivery options returned — will try without delivery');
    }
  } catch (e) {
    console.error('[basket] delivery options fetch error:', e.message);
  }

  const body = {
    BasketId: basketId,
    Config: { ErrorOnProductQuantityChange: false, ErrorOnProductWarning: false },
  };
  if (deliveryId != null) body.DeliveryId = deliveryId;
  if (chosenDeliveryName) body.DeliveryName = chosenDeliveryName;

  console.log(`[basket] POST /api3/order (BasketId=${basketId}):`, JSON.stringify(body));
  const orderResp = await apiRequest('/api3/order', 'POST', body, token);
  const isHtml = typeof orderResp.body === 'string' && orderResp.body.trimStart().startsWith('<');
  console.error('[basket] finalize response:', orderResp.status, isHtml ? '(HTML)' : JSON.stringify(orderResp.body));
  if (![200, 201].includes(orderResp.status)) {
    const msg = isHtml ? `HTTP ${orderResp.status} HTML — wrong endpoint or body` : JSON.stringify(orderResp.body);
    throw new Error(`Błąd finalizacji koszyka: ${msg}`);
  }
  const result = orderResp.body;
  console.log(`[basket] created order ID: ${result?.OrderId || result?.Id || '(unknown)'}`);
  return result;
}

// Convenience wrapper: prepare then immediately finalize (single-step flow).
async function placeOrderViaBasket(opts) {
  const basketId = await prepareBasket(opts);
  return finalizeBasket({ basketId, clientId: opts.clientId, apiKey: opts.apiKey, deliveryName: opts.deliveryName || null });
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
