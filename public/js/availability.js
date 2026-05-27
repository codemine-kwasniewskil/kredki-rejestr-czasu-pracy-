// availabilityTargetUserId is set inline in the EJS template

async function toggleAvailability(date, el) {
  const current = el.dataset.status;
  let next;
  if (!current || current === '') next = 'available';
  else if (current === 'available') next = 'unavailable';
  else next = null;

  // Optimistic update
  updateDayEl(el, next || '', el.dataset.startTime || '', el.dataset.endTime || '');

  try {
    const res = await fetch(`/api/availability/${date}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: next, targetUserId: availabilityTargetUserId })
    });
    const data = await res.json();
    if (res.ok) {
      updateDayEl(el, data.status || '', data.startTime || '', data.endTime || '');
    } else {
      // Revert on failure
      updateDayEl(el, current, el.dataset.startTime || '', el.dataset.endTime || '');
    }
  } catch(e) {
    updateDayEl(el, current, el.dataset.startTime || '', el.dataset.endTime || '');
  }
}

function updateDayEl(el, status, startTime, endTime) {
  el.dataset.status = status;
  el.dataset.startTime = startTime;
  el.dataset.endTime = endTime;

  // Background colour
  el.classList.remove('bg-emerald-50', 'bg-red-50', 'bg-white');
  if (status === 'available') el.classList.add('bg-emerald-50');
  else if (status === 'unavailable') el.classList.add('bg-red-50');
  else el.classList.add('bg-white');

  // Status dot (3rd child div)
  const dot = el.querySelector('div:nth-child(3)');
  if (dot) {
    dot.className = 'w-5 h-5 rounded-md flex items-center justify-center text-[10px] font-bold';
    if (status === 'available') {
      dot.classList.add('bg-emerald-200', 'text-emerald-700', 'border-2', 'border-emerald-400');
      dot.textContent = '✓';
    } else if (status === 'unavailable') {
      dot.classList.add('bg-red-200', 'text-red-700', 'border-2', 'border-red-400');
      dot.textContent = '✕';
    } else {
      dot.classList.add('bg-slate-100', 'text-transparent', 'border-2', 'border-slate-200');
      dot.textContent = '·';
    }
  }

  // Time range display
  const timeRangeEl = el.querySelector('.time-range');
  if (timeRangeEl) {
    if (startTime && endTime) {
      timeRangeEl.textContent = startTime + '–' + endTime;
      timeRangeEl.classList.remove('text-transparent');
      timeRangeEl.classList.add('text-emerald-700', 'font-semibold');
    } else {
      timeRangeEl.textContent = '·';
      timeRangeEl.classList.add('text-transparent');
      timeRangeEl.classList.remove('text-emerald-700', 'font-semibold');
    }
  }

  // Time picker button – show only when available, create if missing
  let tpBtn = el.querySelector('.tp-btn');
  const spacer = el.querySelector('.tp-spacer');

  if (status === 'available') {
    if (!tpBtn) {
      // Remove spacer if present
      if (spacer) spacer.remove();
      tpBtn = document.createElement('button');
      tpBtn.className = 'tp-btn text-[10px] text-slate-400 hover:text-blue-600 leading-none transition-colors';
      tpBtn.title = 'Ustaw godziny';
      tpBtn.textContent = '⏱';
      tpBtn.onclick = (e) => openTimePicker(el.dataset.date, el.dataset.startTime || '', el.dataset.endTime || '', e);
      el.appendChild(tpBtn);
    } else {
      tpBtn.style.display = '';
      tpBtn.onclick = (e) => openTimePicker(el.dataset.date, el.dataset.startTime || '', el.dataset.endTime || '', e);
    }
  } else {
    if (tpBtn) {
      tpBtn.style.display = 'none';
    }
  }
}

// Time picker modal
let _tpEl = null;

function openTimePicker(date, startTime, endTime, event) {
  event.stopPropagation();
  document.getElementById('tpDate').value = date;
  setTimePicker('tpStartPicker', startTime || '');
  setTimePicker('tpEndPicker', endTime || '');
  document.getElementById('tpError').classList.add('hidden');
  _tpEl = document.querySelector(`.availability-day[data-date="${date}"]`);
  document.getElementById('timePickerModal').classList.remove('hidden');
}

function closeTimePicker() {
  document.getElementById('timePickerModal').classList.add('hidden');
  _tpEl = null;
}

async function saveTimeRange() {
  const date = document.getElementById('tpDate').value;
  const startTime = document.getElementById('tpStart').value;
  const endTime = document.getElementById('tpEnd').value;

  const errEl = document.getElementById('tpError');
  errEl.classList.add('hidden');

  if ((startTime && !endTime) || (!startTime && endTime)) {
    errEl.textContent = 'Podaj obie godziny lub zostaw oba pola puste (cały dzień).';
    errEl.classList.remove('hidden');
    return;
  }

  try {
    const res = await fetch(`/api/availability/${date}/time`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ startTime: startTime || null, endTime: endTime || null, targetUserId: availabilityTargetUserId })
    });
    const data = await res.json();
    if (res.ok) {
      if (_tpEl) updateDayEl(_tpEl, data.status, data.startTime || '', data.endTime || '');
      closeTimePicker();
    } else {
      errEl.textContent = data.error || 'Błąd zapisywania.';
      errEl.classList.remove('hidden');
    }
  } catch(e) {
    errEl.textContent = 'Błąd sieci.';
    errEl.classList.remove('hidden');
  }
}

async function clearTimeRange() {
  const date = document.getElementById('tpDate').value;
  try {
    const res = await fetch(`/api/availability/${date}/time`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ startTime: null, endTime: null, targetUserId: availabilityTargetUserId })
    });
    const data = await res.json();
    if (res.ok && _tpEl) updateDayEl(_tpEl, data.status, '', '');
    closeTimePicker();
  } catch(e) { closeTimePicker(); }
}

async function setMonthAvailability(yearMonth, status, event) {
  if (event) event.stopPropagation();
  try {
    const res = await fetch(`/api/availability/month/${yearMonth}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status, targetUserId: availabilityTargetUserId })
    });
    const data = await res.json();
    if (res.ok) {
      if (data.updated === 0) {
        showToast('Brak dni do zaktualizowania w tym miesiącu.');
        return;
      }
      const statusLabel = status === 'available' ? 'Dostępny/a' : 'Niedostępny/a';
      showToast(`${statusLabel}: zaktualizowano ${data.updated} dni.`);
      if (data.dates) {
        data.dates.forEach(date => {
          const el = document.querySelector(`.availability-day[data-date="${date}"]`);
          if (el && el.classList.contains('cursor-pointer')) {
            updateDayEl(el, status, '', '');
          }
        });
      }
    } else {
      showToast(data.error || 'Wystąpił błąd.', 'error');
    }
  } catch(e) {
    showToast('Błąd połączenia.', 'error');
  }
}

document.addEventListener('keydown', e => {
  if (e.key === 'Escape') closeTimePicker();
});
document.getElementById('timePickerModal').addEventListener('click', e => {
  if (e.target === document.getElementById('timePickerModal')) closeTimePicker();
});
