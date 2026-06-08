'use strict';
const https = require('https');
const crypto = require('crypto');

const API_HOST = 'b2b.intermlecz.pl';
const CLIENT_ID = parseInt(process.env.VENDOR_CLIENT_ID || '17456', 10);
const API_KEY = process.env.VENDOR_API_KEY || '1186D3D1-0CD9-45BB-9FE0-0C398D22694D';

// In-memory token cache
let cachedToken = null;
let tokenExpiresAt = 0;

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

async function getToken() {
  if (cachedToken && Date.now() < tokenExpiresAt) return cachedToken;

  const timestamp = utcTimestamp();
  const hash = crypto.createHash('md5')
    .update(API_KEY + timestamp + String(CLIENT_ID))
    .digest('hex');

  const resp = await apiRequest('/api3/token', 'POST', {
    Hash: hash,
    ClientId: CLIENT_ID,
    Timestamp: timestamp,
  });

  if (resp.status !== 200 || !resp.body?.AccessToken) {
    throw new Error(`Vendor API auth failed: ${JSON.stringify(resp.body)}`);
  }

  cachedToken = resp.body.AccessToken;
  tokenExpiresAt = Date.now() + (resp.body.ExpiresIn - 60) * 1000;
  return cachedToken;
}

async function searchProducts(phrase, limit = 20) {
  const token = await getToken();
  const fields = 'Id,Name,Sku,Unit,PriceAfterDiscountNet,RetailPriceNet,Qty,InStock';
  const qs = new URLSearchParams({
    field: fields,
    where: phrase || '',
    orderBy: 'Name',
    order: 'asc',
  });
  const resp = await apiRequest(`/api3/product/findProduct?${qs}`, 'GET', null, token);
  if (resp.status !== 200) throw new Error(`Vendor search failed: ${resp.status}`);
  const items = (resp.body?.Items || []).slice(0, limit);
  return { items, total: resp.body?.TotalCount || items.length };
}

async function getProductsBySku(skus) {
  if (!skus || skus.length === 0) return [];
  const token = await getToken();
  const fields = 'Id,Name,Sku,Unit,PriceAfterDiscountNet,RetailPriceNet,Qty,InStock';
  const skuJson = JSON.stringify(skus);
  const qs = new URLSearchParams({ field: fields, productsSku: skuJson });
  const resp = await apiRequest(`/api3/product/findProduct?${qs}`, 'GET', null, token);
  if (resp.status !== 200) throw new Error(`Vendor lookup failed: ${resp.status}`);
  return resp.body?.Items || [];
}

async function placeOrder({ items, comment }) {
  const token = await getToken();
  // items: [{ vendor_product_key, quantity, unit }]
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
