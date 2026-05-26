'use strict';
const crypto = require('crypto');

// CP1250 (Windows-1250) to Unicode codepoint mapping for bytes 0x80-0xFF
const CP1250 = [
  0x20AC,0xFFFD,0x201A,0xFFFD,0x201E,0x2026,0x2020,0x2021, // 80-87
  0xFFFD,0x2030,0x0160,0x2039,0x015A,0x0164,0x017D,0x0179, // 88-8F
  0xFFFD,0x2018,0x2019,0x201C,0x201D,0x2022,0x2013,0x2014, // 90-97
  0xFFFD,0x2122,0x0161,0x203A,0x015B,0x0165,0x017E,0x017A, // 98-9F
  0x00A0,0x02C7,0x02D8,0x0141,0x00A4,0x0104,0x00A6,0x00A7, // A0-A7
  0x00A8,0x00A9,0x015E,0x00AB,0x00AC,0x00AD,0x00AE,0x017B, // A8-AF
  0x00B0,0x00B1,0x02DB,0x0142,0x00B4,0x00B5,0x00B6,0x00B7, // B0-B7
  0x00B8,0x0105,0x015F,0x00BB,0x013D,0x02DD,0x013E,0x017C, // B8-BF
  0x0154,0x00C1,0x00C2,0x0102,0x00C4,0x0139,0x0106,0x00C7, // C0-C7
  0x010C,0x00C9,0x0118,0x00CB,0x011A,0x00CD,0x00CE,0x010E, // C8-CF
  0x0110,0x0143,0x0147,0x00D3,0x00D4,0x0150,0x00D6,0x00D7, // D0-D7
  0x0158,0x016E,0x00DA,0x0170,0x00DC,0x00DD,0x0162,0x00DF, // D8-DF
  0x0155,0x00E1,0x00E2,0x0103,0x00E4,0x013A,0x0107,0x00E7, // E0-E7
  0x010D,0x00E9,0x0119,0x00EB,0x011B,0x00ED,0x00EE,0x010F, // E8-EF
  0x0111,0x0144,0x0148,0x00F3,0x00F4,0x0151,0x00F6,0x00F7, // F0-F7
  0x0159,0x016F,0x00FA,0x0171,0x00FC,0x00FD,0x0163,0x02D9, // F8-FF
];

function decodeCP1250(buffer) {
  const chars = new Array(buffer.length);
  for (let i = 0; i < buffer.length; i++) {
    const b = buffer[i];
    chars[i] = b < 0x80 ? String.fromCharCode(b) : String.fromCodePoint(CP1250[b - 0x80] || 0xFFFD);
  }
  return chars.join('');
}

function parsePolishAmount(str) {
  if (!str || !str.trim()) return null;
  // "1 234,56" → 1234.56  |  "-1 234,56" → -1234.56
  const cleaned = str.trim().replace(/\s/g, '').replace(',', '.');
  const n = parseFloat(cleaned);
  return isNaN(n) ? null : n;
}

function parsePLNAmount(str) {
  // "43 661,40 PLN" → 43661.40
  if (!str) return null;
  return parsePolishAmount(str.replace(/\s*PLN$/i, '').trim());
}

function parseDateDMY(str) {
  // "01.04.2026" → "2026-04-01"
  if (!str) return null;
  const parts = str.trim().split('.');
  if (parts.length === 3) return `${parts[2]}-${parts[1].padStart(2,'0')}-${parts[0].padStart(2,'0')}`;
  return null;
}

function cleanField(f) {
  if (f === undefined || f === null) return '';
  f = f.trim();
  if ((f.startsWith('"') && f.endsWith('"')) || (f.startsWith("'") && f.endsWith("'"))) {
    f = f.slice(1, -1).trim();
  }
  return f;
}

// Split a semicolon-delimited line respecting double-quoted fields
function splitCSVLine(line) {
  const fields = [];
  let cur = '';
  let inQuote = false;
  let quoteChar = '';
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (!inQuote && (ch === '"' || ch === "'")) {
      inQuote = true;
      quoteChar = ch;
      cur += ch;
    } else if (inQuote && ch === quoteChar) {
      inQuote = false;
      cur += ch;
    } else if (!inQuote && ch === ';') {
      fields.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  fields.push(cur);
  return fields;
}

// Parse card terminal title: "...KWOTA BRUTTO  7053.90 KW. PROW.   39.64KW. VAT  0.00"
const CARD_REGEX = /KWOTA BRUTTO\s+([\d.]+)\s+KW\.\s*PROW\.\s*([\d.]+)/i;
function parseCardTerminalTitle(title) {
  if (!title) return null;
  const m = title.match(CARD_REGEX);
  if (!m) return null;
  const gross = parseFloat(m[1]);
  const fee = parseFloat(m[2]);
  if (isNaN(gross) || isNaN(fee)) return null;
  return { gross, fee };
}

function makeRawHash(accountNumber, tx) {
  const parts = [
    accountNumber || '',
    tx.booking_date || '',
    tx.operation_date || '',
    String(tx.amount ?? ''),
    String(tx.balance_after ?? ''),
    tx.operation_type || '',
    tx.title || '',
    tx.counterparty_name || '',
    tx.counterparty_account || '',
  ];
  return crypto.createHash('sha256').update(parts.join('|')).digest('hex');
}

function isTransactionHeaderLine(line) {
  // Detect the column header row (contains both date and amount column markers)
  return line.includes('Data') && line.includes('Kwota') && line.includes('operacji');
}

function isFooterLine(line) {
  // ";;;;;;#Saldo końcowe;29 084,50 PLN;"
  return line.includes('Saldo') && (line.startsWith(';;') || line.includes('końcowe') || line.includes('koncowe'));
}

/**
 * Parse an mBank CSV buffer (CP1250 encoded).
 * Returns { meta, transactions, errors }
 */
function parseMbankCSV(buffer) {
  const content = decodeCP1250(buffer);
  const rawLines = content.split('\n').map(l => l.replace(/\r$/, ''));

  const result = {
    meta: {
      account_number: null,
      currency: 'PLN',
      period_start: null,
      period_end: null,
      opening_balance: null,
      income_total: null,
      expense_total: null,
      transaction_count: null,
      client_name: null,
    },
    transactions: [],
    errors: [],
    headerLineIndex: -1,
  };

  // Find transaction header line index
  for (let i = 0; i < rawLines.length; i++) {
    if (isTransactionHeaderLine(rawLines[i])) {
      result.headerLineIndex = i;
      break;
    }
  }

  if (result.headerLineIndex === -1) {
    result.errors.push('Nie znaleziono nagłówka transakcji w pliku CSV.');
    return result;
  }

  // ── Parse metadata (lines before header) ──────────────────────────────────
  const meta = result.meta;
  const metaLines = rawLines.slice(0, result.headerLineIndex);

  for (let i = 0; i < metaLines.length; i++) {
    const line = metaLines[i].trim();
    const next = (metaLines[i + 1] || '').trim();

    if (line.includes('Za okres') && !line.includes(';2026') && !line.includes(';2025')) {
      // Period dates are on the next line: "01.04.2026;30.04.2026;"
      const parts = next.split(';').map(p => p.trim()).filter(Boolean);
      if (parts.length >= 2) {
        meta.period_start = parseDateDMY(parts[0]);
        meta.period_end = parseDateDMY(parts[1]);
      }
    }

    if (line === '#Numer rachunku' || line.includes('Numer rachunku')) {
      // Next line: "26 1140 2004 0000 3102 8579 3274 ;"
      const raw = next.split(';')[0].trim().replace(/\s/g, '');
      if (raw && raw.length > 5) meta.account_number = raw;
    }

    if (line === '#Waluta') {
      const val = next.split(';')[0].trim();
      if (val) meta.currency = val;
    }

    if (line === '#Klient') {
      meta.client_name = next.split(';')[0].trim();
    }

    // "#Saldo początkowe;43 661,40 PLN;"
    if (line.startsWith('#Saldo') && line.includes(';') && !line.includes('końcowe') && !line.includes('koncowe')) {
      const parts = line.split(';');
      if (parts[1]) meta.opening_balance = parsePLNAmount(parts[1]);
    }

    // "Uznania;37;99 670,60 PLN;"
    if (line.startsWith('Uznania;')) {
      const parts = line.split(';');
      if (parts[2]) meta.income_total = parsePLNAmount(parts[2]);
    }

    // "Obciążenia;127;-114 247,50 PLN;"  or "Obci...;..."
    if (/^Obci/i.test(line) && line.includes(';')) {
      const parts = line.split(';');
      if (parts[2]) {
        const v = parsePLNAmount(parts[2]);
        meta.expense_total = v !== null ? Math.abs(v) : null;
      }
    }

    // "Łącznie;164;-14 576,90 PLN;"
    if (/^.?cznie;/i.test(line) || line.startsWith('Łącznie;') || line.startsWith('Lacznie;')) {
      const parts = line.split(';');
      if (parts[1]) meta.transaction_count = parseInt(parts[1], 10);
    }
  }

  // ── Parse transaction rows ─────────────────────────────────────────────────
  const txLines = rawLines.slice(result.headerLineIndex + 1);
  let rowNumber = 0;

  for (const line of txLines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed === ';' || isFooterLine(trimmed)) continue;

    const fields = splitCSVLine(trimmed);
    if (fields.length < 7) continue;

    const bookingDate = cleanField(fields[0]);
    // Skip if doesn't look like a date
    if (!/^\d{4}-\d{2}-\d{2}$/.test(bookingDate)) continue;

    rowNumber++;
    const operationDate = cleanField(fields[1]);
    const operationType = cleanField(fields[2]);
    const title = cleanField(fields[3]);
    const counterpartyName = cleanField(fields[4]);
    const counterpartyAccount = cleanField(fields[5]);
    const amountRaw = cleanField(fields[6]);
    const balanceAfterRaw = cleanField(fields[7] || '');

    const amount = parsePolishAmount(amountRaw);
    const balanceAfter = parsePolishAmount(balanceAfterRaw);

    if (amount === null) {
      result.errors.push(`Wiersz ${rowNumber}: nieprawidłowa kwota "${amountRaw}"`);
      continue;
    }

    const monthKey = bookingDate.substring(0, 7);
    const direction = amount >= 0 ? 'income' : 'expense';

    const tx = {
      booking_date: bookingDate,
      operation_date: operationDate || bookingDate,
      operation_type: operationType,
      title,
      counterparty_name: counterpartyName,
      counterparty_account: counterpartyAccount,
      amount,
      balance_after: balanceAfter,
      direction,
      month_key: monthKey,
      raw_row_number: rowNumber,
      raw_hash: null, // filled after account_number is resolved
    };

    result.transactions.push(tx);
  }

  // Compute raw_hash for each transaction
  for (const tx of result.transactions) {
    tx.raw_hash = makeRawHash(meta.account_number, tx);
  }

  return result;
}

module.exports = {
  parseMbankCSV,
  parseCardTerminalTitle,
  parsePolishAmount,
  decodeCP1250,
};
