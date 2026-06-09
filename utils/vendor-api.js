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

async function placeOrder({ items, comment, clientId, apiKey, paymentId, paymentName, deliveryId, deliveryName, address, addressId, additionalProperties }) {
  if (!clientId || !apiKey) throw new Error('Brak danych uwierzytelniających dostawcy dla tej lokalizacji.');

  const token = await getToken(clientId, apiKey);
  const lines = items
    .filter(i => i.vendor_product_key)
    .map(i => ({
      Key: String(i.vendor_product_key),
      Quantity: Number(i.quantity),
      UnitId: String(i.unit || ''),
    }));

  if (lines.length === 0) throw new Error('Brak produktów z kluczem SKU dostawcy.');

  const body = {
    AddressId: addressId ? parseInt(addressId, 10) : null,
    Address: {
      Name:            address?.Name            || '',
      Street:          address?.Street          || '',
      City:            address?.City            || '',
      PostalCode:      address?.PostalCode      || '',
      Phone:           address?.Phone           || '',
      CountryId:       address?.CountryId       || null,
      RegionId:        address?.RegionId        || null,
      Email:           address?.Email           || '',
      ApartmentNumber: address?.ApartmentNumber || '',
      HouseNumber:     address?.HouseNumber     || '',
      TaxNumber:       address?.TaxNumber       || '',
      OneTimeAdress:   true,
    },
    PaymentId:            paymentId  ? parseInt(paymentId, 10)  : null,
    PaymentName:          paymentName  || '',
    DeliveryId:           deliveryId ? parseInt(deliveryId, 10) : null,
    DeliveryName:         deliveryName || '',
    Comment:              comment || 'Zamówienie z systemu Kredki',
    OrderLines:           { KeyType: 'Sku', Lines: lines },
    InpostPaczkomatCode:  '',
    AdditionalProperties: additionalProperties || [],
    Config:               { ErrorOnProductQuantityChange: false, ErrorOnProductWarning: false },
  };

  console.log('[placeOrder] POST /api3/order body:', JSON.stringify(body, null, 2));
  const resp = await apiRequest('/api3/order', 'POST', body, token);
  console.log('[placeOrder] response status:', resp.status, 'body:', JSON.stringify(resp.body));
  if (resp.status !== 200) {
    const msg = typeof resp.body === 'string' ? resp.body : JSON.stringify(resp.body);
    throw new Error(`Błąd składania zamówienia: ${msg}`);
  }
  return resp.body;
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

module.exports = { getToken, searchProducts, getProductsBySku, placeOrder, getDeliveryOptions, getClientAddresses };
