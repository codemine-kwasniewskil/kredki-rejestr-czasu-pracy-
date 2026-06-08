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

async function searchProducts(phrase, limit = 20, creds = {}) {
  const { clientId, apiKey } = creds;
  if (!clientId || !apiKey) throw new Error('Brak danych uwierzytelniających dostawcy dla tej lokalizacji.');
  const token = await getToken(clientId, apiKey);
  const fields = 'Id,Name,Sku,Unit,PriceAfterDiscountNet,RetailPriceNet,Qty,InStock';
  const qs = new URLSearchParams({ field: fields, where: phrase || '', orderBy: 'Name', order: 'asc' });
  const resp = await apiRequest(`/api3/product/findProduct?${qs}`, 'GET', null, token);
  if (resp.status !== 200) throw new Error(`Vendor search failed: ${resp.status}`);
  const items = (resp.body?.Items || []).slice(0, limit);
  return { items, total: resp.body?.TotalCount || items.length };
}

async function getProductsBySku(skus, creds = {}) {
  if (!skus || skus.length === 0) return [];
  const { clientId, apiKey } = creds;
  if (!clientId || !apiKey) throw new Error('Brak danych uwierzytelniających dostawcy dla tej lokalizacji.');
  const token = await getToken(clientId, apiKey);
  const fields = 'Id,Name,Sku,Unit,PriceAfterDiscountNet,RetailPriceNet,Qty,InStock';
  const qs = new URLSearchParams({ field: fields, productsSku: JSON.stringify(skus) });
  const resp = await apiRequest(`/api3/product/findProduct?${qs}`, 'GET', null, token);
  if (resp.status !== 200) throw new Error(`Vendor lookup failed: ${resp.status}`);
  return resp.body?.Items || [];
}

async function placeOrder({ items, comment, clientId, apiKey }) {
  if (!clientId || !apiKey) throw new Error('Brak danych uwierzytelniających dostawcy dla tej lokalizacji.');
  const token = await getToken(clientId, apiKey);
  const lines = items
    .filter(i => i.vendor_product_key)
    .map(i => ({ Key: String(i.vendor_product_key), Quantity: Number(i.quantity) }));

  if (lines.length === 0) throw new Error('Brak produktów z kluczem SKU dostawcy.');

  const body = {
    Comment: comment || 'Zamówienie z systemu Kredki',
    OrderLines: { KeyType: 'Sku', Lines: lines },
  };

  const resp = await apiRequest('/api3/order', 'POST', body, token);
  if (resp.status !== 200) {
    const msg = typeof resp.body === 'string' ? resp.body : JSON.stringify(resp.body);
    throw new Error(`Błąd składania zamówienia: ${msg}`);
  }
  return resp.body;
}

module.exports = { getToken, searchProducts, getProductsBySku, placeOrder };
