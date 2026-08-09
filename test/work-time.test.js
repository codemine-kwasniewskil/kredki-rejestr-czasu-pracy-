'use strict';
const assert = require('assert');
const { buildDay, summarize } = require('../utils/workTime');

// ── Test runner ───────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (e) {
    console.error(`  ✗ ${name}`);
    console.error(`    ${e.message}`);
    failed++;
  }
}

// ── Fixtures ─────────────────────────────────────────────────────────────────

// Zmiana 8:00–16:00 (8h planu) na dzień 2026-08-03, odbicia podawane per test.
function entry(overrides = {}) {
  return {
    id: 1,
    date: '2026-08-03',
    start_time: '08:00',
    end_time: '16:00',
    work_started_at: null,
    work_ended_at: null,
    ...overrides,
  };
}

// Odbicia liczone od 8:00 tego samego dnia, o zadanej liczbie minut.
function punched(minutes) {
  const endMin = 8 * 60 + minutes;
  const hh = String(Math.floor(endMin / 60)).padStart(2, '0');
  const mm = String(endMin % 60).padStart(2, '0');
  return entry({
    work_started_at: '2026-08-03 08:00:00',
    work_ended_at: `2026-08-03 ${hh}:${mm}:00`,
  });
}

console.log('\nworkTime\n');

// 1. Zmiana nocna: koniec ma datę następnego dnia, godziny muszą wyjść dodatnie
test('zmiana nocna przez północ daje dodatnie godziny faktyczne', () => {
  const d = buildDay(entry({
    start_time: '22:00',
    end_time: '06:00',
    work_started_at: '2026-08-03 22:00:00',
    work_ended_at: '2026-08-04 06:30:00',
  }));
  assert.strictEqual(d.actualHours, 8.5);
  assert.strictEqual(d.status, 'roznica');
  assert.strictEqual(Math.round(d.diff * 60), 30);
});

// 2. Ktoś rozpoczął pracę i zapomniał zakończyć
test('start bez końca to dzień do sprawdzenia bez różnicy', () => {
  const d = buildDay(entry({ work_started_at: '2026-08-03 08:05:00' }));
  assert.strictEqual(d.status, 'do_sprawdzenia');
  assert.strictEqual(d.diff, null);
  assert.strictEqual(d.actualHours, null);
});

// 3. Zmiana z grafiku, na której nikt nie odbił
test('brak obu odbić to dzień do sprawdzenia bez różnicy', () => {
  const d = buildDay(entry());
  assert.strictEqual(d.status, 'do_sprawdzenia');
  assert.strictEqual(d.diff, null);
  assert.strictEqual(d.plannedHours, 8);
});

// 4. Próg tolerancji — 15 minut, po obu stronach
test('różnica 14 minut mieści się w tolerancji', () => {
  assert.strictEqual(buildDay(punched(8 * 60 + 14)).status, 'zgodne');
});

test('różnica 15 minut przekracza tolerancję', () => {
  assert.strictEqual(buildDay(punched(8 * 60 + 15)).status, 'roznica');
});

test('różnica -15 minut też przekracza tolerancję', () => {
  const d = buildDay(punched(8 * 60 - 15));
  assert.strictEqual(d.status, 'roznica');
  assert.strictEqual(Math.round(d.diff * 60), -15);
});

// 5. Dzień bez zmiany w grafiku nie jest brakiem odbicia
test('dzień bez wpisu w grafiku ma status brak_zmiany', () => {
  const d = buildDay(null);
  assert.strictEqual(d.status, 'brak_zmiany');
  assert.strictEqual(d.plannedHours, 0);
  assert.strictEqual(d.diff, null);
});

// 6. Sumy: plan ze wszystkich dni, reszta tylko z dni z pełnym odbiciem
test('sumy liczą plan ze wszystkich dni, a różnicę tylko z odbitych', () => {
  const s = summarize([
    buildDay(punched(8 * 60 + 30)),   // 8h planu, 8,5h faktycznie, +30 min
    buildDay(entry()),                 // 8h planu, brak odbicia
    buildDay(null),                    // wolne
  ]);
  assert.strictEqual(s.totalPlanned, 16);
  assert.strictEqual(s.totalActual, 8.5);
  assert.strictEqual(Math.round(s.totalDiff * 60), 30);
  assert.strictEqual(s.scheduledDays, 2);
  assert.strictEqual(s.matchedDays, 1);
  assert.strictEqual(s.toCheckDays, 1);
});

// 7. Regresja: naiwne totalActual - totalPlanned dałoby fałszywy minus
test('różnica razem nie jest liczona jako faktycznie razem minus plan razem', () => {
  const s = summarize([
    buildDay(punched(8 * 60)),   // zgodne co do minuty
    buildDay(entry()),           // brak odbicia — 8h planu poza porównaniem
  ]);
  assert.strictEqual(s.totalDiff, 0);
  assert.strictEqual(s.totalActual - s.totalPlanned, -8);
});

// ── Results ──────────────────────────────────────────────────────────────────

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
