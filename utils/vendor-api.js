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

// Steps 1-5: create basket, add each product via the item endpoint, fetch additional
// parameters, PATCH metadata (comment/address/delivery), verify. Returns the basket ID
// so it can be inspected on the B2B platform before finalization.
async function prepareBasket({ items, comment, clientId, apiKey, paymentName, address, addressId, deliveryDate, ownOrderNumber }) {
  if (!clientId || !apiKey) throw new Error('Brak danych uwierzytelniających dostawcy dla tej lokalizacji.');

  const token = await getToken(clientId, apiKey);

  // Products are added one-by-one via POST /api3/basket/{id}/item (see Step 2). Passing
  // products as `Lines` in the create body OR in the PATCH is silently ignored by the API
  // (basket ends up with Items:[]). The item endpoint requires a real numeric UnitId — the
  // "-3" sentinel is rejected ("does not have unit with id: -3"). The XML catalog only stores
  // the unit *symbol* (e.g. "szt."), so we look up each product's numeric unit ids at order
  // time via /api3/product/findProduct (see resolveUnitIds) and match on the symbol.
  const lines = items
    .filter(i => i.vendor_product_key)
    .map(i => ({ Sku: String(i.vendor_product_key), Quantity: Number(i.quantity), Unit: i.unit || null }));

  if (lines.length === 0) throw new Error('Brak produktów z kluczem SKU dostawcy.');

  // Step 1: Create an empty basket. The POST body (Lines, Comment, …) is ignored by the API —
  // a GET on the new basket shows Items:[] and Comment:null regardless of what we send here.
  // Everything that actually sticks (products, comment, address, delivery) is applied via PATCH.
  const ts = new Date().toISOString().replace('T', ' ').substring(0, 16);
  const basketBody = { BasketName: `${comment || 'Zamówienie'} (${ts})`, ShowOnFront: true };
  if (paymentName) basketBody.PaymentName = paymentName;

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

  // Step 2: Resolve each product's numeric UnitId, then add it with its own
  // POST /api3/basket/{id}/item call. This is the only way products actually land in the
  // basket — `Lines` in the create body / PATCH is ignored.
  const unitIdBySku = await resolveUnitIds(lines, token);

  let addedCount = 0;
  const addFailures = [];
  for (const line of lines) {
    const unitId = unitIdBySku.get(line.Sku);
    if (!unitId) {
      addFailures.push(`${line.Sku}: brak jednostki (UnitId) — nie znaleziono produktu w katalogu dostawcy`);
      console.error(`[basket] add item SKU=${line.Sku} SKIPPED: could not resolve UnitId`);
      continue;
    }
    const itemBody = {
      ProductKey: { KeyType: 'Sku', Key: line.Sku },
      Quantity: String(line.Quantity),
      UnitId: String(unitId),
      Config: { ErrorOnProductQuantityChange: false, ErrorOnProductWarning: false },
    };
    const itemResp = await apiRequest(`/api3/basket/${basketId}/item`, 'POST', itemBody, token);
    const itemBodyRaw = typeof itemResp.body === 'string' ? itemResp.body : JSON.stringify(itemResp.body);
    if ([200, 201, 204].includes(itemResp.status)) {
      addedCount++;
      console.log(`[basket] added item SKU=${line.Sku} qty=${line.Quantity} unitId=${unitId}: ${itemResp.status}`);
    } else {
      addFailures.push(`${line.Sku}: HTTP ${itemResp.status} ${itemBodyRaw}`);
      console.error(`[basket] add item SKU=${line.Sku} FAILED: ${itemResp.status} ${itemBodyRaw}`);
    }
  }
  if (addedCount === 0) {
    throw new Error(`Nie udało się dodać żadnego produktu do koszyka: ${addFailures.join('; ')}`);
  }
  if (addFailures.length > 0) {
    console.warn(`[basket] ${addFailures.length} produkt(ów) nie dodano: ${addFailures.join('; ')}`);
  }

  // Step 3: Fetch basket-specific additional parameters to learn what the API accepts
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

  // Step 4: PATCH basket metadata — comment, address, delivery date and ShowOnFront. Products
  // are NOT sent here (they were added via the item endpoint in Step 2); `Lines` is ignored.
  const patchBody = { Delivery: null, ShowOnFront: true };
  if (comment) patchBody.Comment = comment;
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
  // Delivery (realization) date is a custom additional parameter, not a top-level basket field.
  // It must be sent in the `AdditionalProperties` array as { Key, Values:[…] }; a top-level
  // field (e.g. RequestedDeliveryDate) is ignored. The basket's own key is `DataRealizacjiZamowienia`.
  const additionalProperties = [];
  if (deliveryDate) {
    const dateKey = _resolveAdditionalParamName(
      additionalParams, ['DataRealizacjiZamowienia', 'RequestedDeliveryDate', 'DeliveryDate'], 'DataRealizacjiZamowienia');
    const dateValue = _formatDate(deliveryDate);
    additionalProperties.push({ Key: dateKey, Values: [dateValue] });
    console.log(`[basket] mapping deliveryDate → AdditionalProperties[${dateKey}]: ${dateValue}`);
  }
  // Own order number → platform's dedicated nr_wlasny field (NOT the comment).
  if (ownOrderNumber) {
    const ownKey = _resolveAdditionalParamName(additionalParams, ['nr_wlasny'], 'nr_wlasny');
    additionalProperties.push({ Key: ownKey, Values: [String(ownOrderNumber)] });
    console.log(`[basket] mapping ownOrderNumber → AdditionalProperties[${ownKey}]: ${ownOrderNumber}`);
  }
  if (additionalProperties.length > 0) patchBody.AdditionalProperties = additionalProperties;

  // Payment method: the basket only accepts a numeric PaymentId, so resolve the configured
  // payment *name* against /api3/order/payment. If it can't be resolved we skip it (the order
  // can still be finalized with PaymentName at POST /api3/order time).
  if (paymentName) {
    const paymentId = await _resolvePaymentId(paymentName, token);
    if (paymentId != null) {
      patchBody.PaymentId = paymentId;
      console.log(`[basket] resolved payment "${paymentName}" → PaymentId ${paymentId}`);
    } else {
      console.warn(`[basket] could not resolve PaymentId for "${paymentName}" — leaving payment unset on basket`);
    }
  }

  console.log(`[basket] PATCH /api3/basket/${basketId}:`, JSON.stringify(patchBody, null, 2));
  const patchResp = await apiRequest(`/api3/basket/${basketId}`, 'PATCH', patchBody, token);
  console.error('[basket] PATCH response:', patchResp.status, JSON.stringify(patchResp.body));
  if (![200, 201, 204].includes(patchResp.status)) {
    const msg = typeof patchResp.body === 'string' ? patchResp.body : JSON.stringify(patchResp.body);
    throw new Error(`Błąd aktualizacji koszyka: ${msg}`);
  }

  // Step 5: Verify the basket actually contains the items before returning it.
  try {
    const verifyResp = await apiRequest(`/api3/basket/${basketId}`, 'GET', null, token);
    const bodyRaw = typeof verifyResp.body === 'string' ? verifyResp.body : JSON.stringify(verifyResp.body);
    console.error(`[basket] verify GET /api3/basket/${basketId}: status=${verifyResp.status} body=${bodyRaw}`);
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

// Resolves the numeric UnitId for each order line. The basket item endpoint requires a real
// UnitId (the "-3" sentinel is rejected), but the XML catalog only stores the unit *symbol*.
// So we query /api3/product/findProduct (which returns a Units array with numeric Ids) for the
// order's SKUs, then pick — per line — the unit whose Name matches the line's symbol, falling
// back to the Primary unit, then the first available unit.
// Returns Map<Sku, unitId>. SKUs not found in the catalog response are simply absent.
async function resolveUnitIds(lines, token) {
  const out = new Map();
  const skus = [...new Set(lines.map(l => l.Sku))];
  if (skus.length === 0) return out;

  // Fetch products' Units arrays from findProduct. Try one batched call first
  // (productsSku may accept a comma-separated list — covers the whole order in 1 request,
  // keeping us under the 100 req/hour /api3 limit), then fall back to per-SKU calls for any
  // SKU the batched response didn't return.
  const unitBySku = new Map();
  const fetchUnits = async (skuParam) => {
    const path = `/api3/product/findProduct?field=Id,Sku,Unit,Units&productsSku=${encodeURIComponent(skuParam)}`;
    try {
      const resp = await apiRequest(path, 'GET', null, token);
      if (resp.status !== 200) {
        console.error('[basket] resolveUnitIds findProduct non-200:', resp.status, JSON.stringify(resp.body));
        return;
      }
      for (const p of (resp.body?.Items || [])) {
        if (p.Sku != null) unitBySku.set(String(p.Sku), Array.isArray(p.Units) ? p.Units : []);
      }
    } catch (e) {
      console.error('[basket] resolveUnitIds findProduct error:', e.message);
    }
  };

  await fetchUnits(skus.join(','));
  const missing = skus.filter(s => !unitBySku.has(s));
  for (const sku of missing) await fetchUnits(sku);

  for (const line of lines) {
    const units = unitBySku.get(line.Sku);
    if (!units || units.length === 0) continue;
    const wanted = (line.Unit || '').trim().toLowerCase();
    const byName = wanted ? units.find(u => String(u.Name || '').trim().toLowerCase() === wanted) : null;
    const chosen = byName || units.find(u => u.Primary) || units[0];
    if (chosen?.Id != null) {
      out.set(line.Sku, chosen.Id);
      if (!byName && wanted) {
        console.warn(`[basket] SKU=${line.Sku} unit "${line.Unit}" not in product units (${units.map(u => u.Name).join(', ')}) — using ${chosen.Name} (id=${chosen.Id})`);
      }
    }
  }
  return out;
}

// Looks for a parameter key in the additionalparameters API response, falling back to defaultName.
// candidateNames is checked in priority order against each item's Key/Name (case-insensitive).
function _resolveAdditionalParamName(additionalParams, candidateNames, defaultName) {
  const items = additionalParams?.Items || additionalParams?.AdditionalParameters || [];
  const matches = (p, candidate) =>
    String(p.Key ?? '').toLowerCase() === candidate.toLowerCase() ||
    String(p.Name ?? '').toLowerCase() === candidate.toLowerCase();
  for (const candidate of candidateNames) {
    if (items.some(p => matches(p, candidate))) return candidate;
  }
  return defaultName;
}

// Normalizes a delivery date (Date or string) to YYYY-MM-DD, which is what the API expects.
function _formatDate(d) {
  if (d instanceof Date) return d.toISOString().slice(0, 10);
  const s = String(d).trim();
  return s.length >= 10 ? s.slice(0, 10) : s;
}

// Resolves a payment method *name* to its numeric Id via GET /api3/order/payment.
// The configured payment name is expected to be one of the platform's actual options (chosen
// from the dropdown in order settings, populated from GET /api3/order/payment). Matching is by
// exact name (case-insensitive); we also accept a "normalized" match that ignores a trailing
// "(…)" suffix because the deferred-term option's name carries a volatile day count, e.g.
// "Odroczony termin płatności dni (0)" → "(7)". No synonym/fuzzy mapping — the stored value must
// be a real platform option. Returns null when the list can't be fetched or nothing matches.
async function _resolvePaymentId(paymentName, token) {
  try {
    const resp = await apiRequest('/api3/order/payment', 'GET', null, token);
    if (resp.status !== 200) {
      console.warn('[basket] /api3/order/payment non-200:', resp.status, JSON.stringify(resp.body));
      return null;
    }
    const items = (resp.body?.Items || []).filter(p => p?.Name != null);
    const ci = s => String(s).trim().toLowerCase();
    const norm = s => ci(s).replace(/\s*\([^)]*\)\s*$/, '').replace(/\s+/g, ' ').trim();
    const wanted = ci(paymentName);
    const wantedNorm = norm(paymentName);

    const match = items.find(p => ci(p.Name) === wanted) || items.find(p => norm(p.Name) === wantedNorm);
    if (!match) {
      console.warn(`[basket] no payment match for "${paymentName}". Available: ${items.map(p => p.Name).join(' | ')}`);
      return null;
    }
    return match.Id ?? null;
  } catch (e) {
    console.warn('[basket] _resolvePaymentId error:', e.message);
    return null;
  }
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

async function getPaymentOptions(creds = {}) {
  const { clientId, apiKey } = creds;
  if (!clientId || !apiKey) throw new Error('Brak danych uwierzytelniających dostawcy.');
  const token = await getToken(clientId, apiKey);
  const resp = await apiRequest('/api3/order/payment', 'GET', null, token);
  if (resp.status !== 200) {
    throw new Error(`Payment API error: ${resp.status} — ${JSON.stringify(resp.body)}`);
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

module.exports = { getToken, searchProducts, getProductsBySku, prepareBasket, finalizeBasket, placeOrderViaBasket, getDeliveryOptions, getPaymentOptions, getClientAddresses };
