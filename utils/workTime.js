'use strict';

// Rzeczywisty czas pracy — porównanie planu z grafiku z odbiciami
// (Start pracy / Koniec pracy). Funkcje czyste, testy w test/work-time.test.js.

const { calcHours } = require('./helpers');

// Poniżej tej różnicy dzień uznajemy za zgodny z grafikiem — drobne rozjazdy
// przy klikaniu są normalne i nie warto ich podświetlać.
const TOLERANCE_HOURS = 15 / 60;

// Odbicia trzymamy jako DATETIME ('YYYY-MM-DD HH:MM:SS'); pula ma dateStrings,
// więc do JS-a wracają jako stringi w czasie lokalnym pracownika.
function parseWorkDt(value) {
  if (!value) return null;
  const d = new Date(String(value).replace(' ', 'T'));
  return isNaN(d.getTime()) ? null : d;
}

// 'YYYY-MM-DD HH:MM:SS' → 'HH:MM' (do wyświetlenia i do przepisania w grafik).
function workHM(value) {
  if (!value) return '';
  return String(value).replace('T', ' ').slice(11, 16);
}

// Liczone z pełnych dat, nie z HH:MM — koniec zmiany nocnej ma datę następnego dnia.
function actualHours(startValue, endValue) {
  const start = parseWorkDt(startValue);
  const end = parseWorkDt(endValue);
  if (!start || !end) return null;
  return (end - start) / 3600000;
}

function buildDay(entry) {
  if (!entry) {
    return {
      entry: null,
      status: 'brak_zmiany',
      plannedHours: 0,
      actualHours: null,
      diff: null,
      actualStart: '',
      actualEnd: '',
    };
  }

  const plannedHours = calcHours(entry.start_time, entry.end_time);
  const hours = actualHours(entry.work_started_at, entry.work_ended_at);
  const diff = hours === null ? null : hours - plannedHours;

  let status;
  if (diff === null) status = 'do_sprawdzenia';
  else if (Math.abs(diff) < TOLERANCE_HOURS) status = 'zgodne';
  else status = 'roznica';

  return {
    entry,
    status,
    plannedHours,
    actualHours: hours,
    diff,
    actualStart: workHM(entry.work_started_at),
    actualEnd: workHM(entry.work_ended_at),
  };
}

// Plan sumujemy ze wszystkich dni z grafiku, resztę tylko z dni z pełnym odbiciem.
// Różnicy razem NIE wolno liczyć jako totalActual - totalPlanned: dni bez odbicia
// są w drugiej sumie a nie w pierwszej, więc wyszedłby fałszywy minus.
function summarize(days) {
  let totalPlanned = 0, totalActual = 0, totalDiff = 0;
  let scheduledDays = 0, matchedDays = 0, toCheckDays = 0;

  for (const d of days) {
    if (d.status === 'brak_zmiany') continue;
    scheduledDays++;
    totalPlanned += d.plannedHours;
    if (d.diff === null) {
      toCheckDays++;
    } else {
      matchedDays++;
      totalActual += d.actualHours;
      totalDiff += d.diff;
    }
  }

  return { totalPlanned, totalActual, totalDiff, scheduledDays, matchedDays, toCheckDays };
}

// Jednolity opis zmiany godzin do activity_logs. Prefiks "Zmiana #<id>" jest
// jednocześnie kluczem, po którym Karta czasu pracy wyszukuje wpisy dla swoich dni,
// więc format musi być wspólny dla wszystkich miejsc, które ruszają godziny.
function describeTimeChange({ id, date, name, from, to }) {
  const span = ([start, end]) => (start && end ? `${start}–${end}` : '—');
  return `Zmiana #${id} (${String(date).slice(0, 10)}) ${name}: ${span(from)} → ${span(to)}`;
}

module.exports = {
  buildDay, summarize, actualHours, parseWorkDt, workHM, describeTimeChange, TOLERANCE_HOURS,
};
