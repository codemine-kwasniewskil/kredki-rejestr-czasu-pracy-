function getMonday(date) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  const day = d.getDay();
  const diff = day === 0 ? -6 : 1 - day;
  d.setDate(d.getDate() + diff);
  return d;
}

function getWeekDates(weekStart) {
  const start = new Date(weekStart + 'T00:00:00');
  return Array.from({ length: 7 }, (_, i) => {
    const d = new Date(start);
    d.setDate(start.getDate() + i);
    return d;
  });
}

function toDateString(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function calcHours(startTime, endTime) {
  if (!startTime || !endTime) return 0;
  const [sh, sm] = startTime.split(':').map(Number);
  const [eh, em] = endTime.split(':').map(Number);
  let minutes = (eh * 60 + em) - (sh * 60 + sm);
  if (minutes < 0) minutes += 24 * 60;
  return minutes / 60;
}

function formatHours(hours) {
  if (!hours) return '0h';
  const h = Math.floor(hours);
  const m = Math.round((hours - h) * 60);
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}

function prevWeekStart(weekStart) {
  const d = new Date(weekStart + 'T00:00:00');
  d.setDate(d.getDate() - 7);
  return toDateString(d);
}

function nextWeekStart(weekStart) {
  const d = new Date(weekStart + 'T00:00:00');
  d.setDate(d.getDate() + 7);
  return toDateString(d);
}

const DAY_NAMES_PL = ['Pon', 'Wt', 'Śr', 'Czw', 'Pt', 'Sob', 'Nd'];
const MONTH_NAMES_PL = ['sty','lut','mar','kwi','maj','cze','lip','sie','wrz','paź','lis','gru'];

function formatDayHeader(date) {
  const dayIdx = date.getDay() === 0 ? 6 : date.getDay() - 1;
  return `${DAY_NAMES_PL[dayIdx]} ${date.getDate()} ${MONTH_NAMES_PL[date.getMonth()]}`;
}

function formatWeekRange(weekStart) {
  const dates = getWeekDates(weekStart);
  const from = dates[0];
  const to = dates[6];
  return `${from.getDate()} ${MONTH_NAMES_PL[from.getMonth()]} – ${to.getDate()} ${MONTH_NAMES_PL[to.getMonth()]} ${to.getFullYear()}`;
}

module.exports = { getMonday, getWeekDates, toDateString, calcHours, formatHours, prevWeekStart, nextWeekStart, formatDayHeader, formatWeekRange };
