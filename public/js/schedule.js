let draggedEntryId = null;
let draggedBlock = null;
let draggedSourceCell = null;

function handleDragStart(event, el) {
  draggedEntryId = el.dataset.entryId;
  draggedBlock = el;
  draggedSourceCell = el.closest('.schedule-cell');
  event.dataTransfer.effectAllowed = 'move';
  setTimeout(() => { el.style.opacity = '0.4'; }, 0);
}

function handleDragEnd(event, el) {
  el.style.opacity = '1';
  document.querySelectorAll('.drag-over').forEach(c => c.classList.remove('drag-over'));
  draggedEntryId = null;
  draggedBlock = null;
  draggedSourceCell = null;
}

async function handleDrop(event, cell) {
  cell.classList.remove('drag-over');

  // Capture before dragend fires and clears the globals
  const entryId = draggedEntryId;
  const block = draggedBlock;
  const sourceCell = draggedSourceCell;
  if (!entryId || !block) return;

  const newDate = cell.dataset.date;
  const newUserId = cell.dataset.userId;

  if (cell.querySelector('.shift-block')) {
    showToast('Ta komórka jest już zajęta.', 'error');
    return;
  }

  try {
    const res = await fetch(`/api/schedule/entry/${entryId}/move`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ newDate, newUserId })
    });
    const data = await res.json();
    if (res.ok) {
      // Remove the + button from the target cell, then add the block
      const existingPlus = cell.querySelector('button');
      if (existingPlus) existingPlus.remove();
      cell.appendChild(block);
      block.style.opacity = '1';

      // Restore + button to the source cell (now empty)
      if (sourceCell && sourceCell !== cell && !sourceCell.querySelector('.shift-block')) {
        const scheduleId = sourceCell.dataset.scheduleId;
        const date = sourceCell.dataset.date;
        const userId = sourceCell.dataset.userId;
        const btn = document.createElement('button');
        btn.className = 'w-full h-12 text-slate-300 hover:text-blue-400 hover:bg-blue-50 rounded-md flex items-center justify-center text-lg transition-colors border-2 border-transparent hover:border-blue-200 border-dashed';
        btn.title = 'Dodaj zmianę';
        btn.textContent = '+';
        btn.onclick = () => openAddShift(date, userId, scheduleId);
        sourceCell.appendChild(btn);
      }

      updateHoursRow();
    } else {
      block.style.opacity = '1';
      showToast(data.error || 'Błąd przenoszenia zmiany.', 'error');
    }
  } catch (e) {
    block.style.opacity = '1';
    showToast('Błąd sieci.', 'error');
  }
}

function openAddShift(date, userId, scheduleId) {
  document.getElementById('modalDate').value = date;
  document.getElementById('modalUserId').value = userId;
  document.getElementById('modalScheduleId').value = scheduleId;
  document.getElementById('modalTemplate').value = '';
  setTimePicker('modalStartPicker', '');
  setTimePicker('modalEndPicker', '');
  document.querySelector('#addShiftForm [name="notes"]').value = '';
  document.getElementById('modalError').classList.add('hidden');
  document.getElementById('addShiftModal').classList.remove('hidden');
}

function closeAddShift() {
  document.getElementById('addShiftModal').classList.add('hidden');
}

function applyTemplate() {
  const sel = document.getElementById('modalTemplate');
  const opt = sel.options[sel.selectedIndex];
  if (opt.value) {
    setTimePicker('modalStartPicker', opt.dataset.start || '');
    setTimePicker('modalEndPicker', opt.dataset.end || '');
  } else {
    setTimePicker('modalStartPicker', '');
    setTimePicker('modalEndPicker', '');
  }
}

document.getElementById('addShiftForm').addEventListener('submit', async function(e) {
  e.preventDefault();
  const fd = new FormData(this);
  const payload = {
    scheduleId: fd.get('scheduleId'),
    userId: fd.get('userId'),
    date: fd.get('date'),
    shiftTemplateId: fd.get('shiftTemplateId') || null,
    customStart: fd.get('customStart') || null,
    customEnd: fd.get('customEnd') || null,
    notes: fd.get('notes') || null,
  };

  const errEl = document.getElementById('modalError');
  errEl.classList.add('hidden');

  try {
    const res = await fetch('/api/schedule/entry', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const data = await res.json();

    if (res.ok) {
      closeAddShift();
      addEntryToCell(data.entry, payload.scheduleId);
      updateHoursRow();
    } else {
      errEl.textContent = data.error || 'Błąd dodawania zmiany.';
      errEl.classList.remove('hidden');
    }
  } catch(err) {
    errEl.textContent = 'Błąd sieci.';
    errEl.classList.remove('hidden');
  }
});

function addEntryToCell(entry, scheduleId) {
  const cell = document.querySelector(
    `.schedule-cell[data-user-id="${entry.user_id}"][data-date="${entry.date}"]`
  );
  if (!cell) { window.location.reload(); return; }

  const plusBtn = cell.querySelector('button');
  if (plusBtn) plusBtn.remove();

  const block = document.createElement('div');
  block.className = 'shift-block rounded-md px-2 py-1.5 text-white text-xs flex flex-col gap-0.5 shadow-sm relative group/block';
  block.style.backgroundColor = entry.color;
  block.draggable = true;
  block.dataset.entryId = entry.id;
  block.setAttribute('ondragstart', 'handleDragStart(event, this)');
  block.setAttribute('ondragend', 'handleDragEnd(event, this)');

  block.innerHTML = `
    <span class="font-semibold leading-tight">${entry.shift_name}</span>
    <span class="opacity-90">${entry.start_time} – ${entry.end_time}</span>
    ${entry.notes ? `<span class="opacity-75 text-xs italic truncate">${entry.notes}</span>` : ''}
    <button onclick="deleteEntry(${entry.id}, event)" class="absolute top-1 right-1 opacity-0 group-hover/block:opacity-100 text-white/80 hover:text-white leading-none text-xs w-4 h-4 flex items-center justify-center bg-black/20 rounded transition-opacity" title="Usuń zmianę">✕</button>
  `;

  cell.appendChild(block);
}

async function deleteEntry(entryId, event) {
  event.stopPropagation();
  if (!confirm('Usunąć tę zmianę?')) return;

  const block = document.querySelector(`[data-entry-id="${entryId}"]`);
  const cell = block?.closest('.schedule-cell');

  try {
    const res = await fetch(`/api/schedule/entry/${entryId}`, { method: 'DELETE' });
    const data = await res.json();
    if (res.ok) {
      if (block) block.remove();
      if (cell) {
        const scheduleId = cell.dataset.scheduleId;
        const date = cell.dataset.date;
        const userId = cell.dataset.userId;
        const plusBtn = document.createElement('button');
        plusBtn.className = 'w-full h-12 text-slate-300 hover:text-blue-400 hover:bg-blue-50 rounded-md flex items-center justify-center text-lg transition-colors border-2 border-transparent hover:border-blue-200 border-dashed';
        plusBtn.title = 'Dodaj zmianę';
        plusBtn.textContent = '+';
        plusBtn.onclick = () => openAddShift(date, userId, scheduleId);
        cell.appendChild(plusBtn);
      }
      updateHoursRow();
    } else {
      showToast(data.error || 'Błąd usuwania.', 'error');
    }
  } catch(e) {
    showToast('Błąd sieci.', 'error');
  }
}

function updateHoursRow() {
  const rows = document.querySelectorAll('tbody tr');
  rows.forEach(row => {
    const cells = row.querySelectorAll('.schedule-cell');
    let weekTotal = 0;
    cells.forEach(cell => {
      const block = cell.querySelector('.shift-block');
      if (block) {
        const timeSpan = block.querySelectorAll('span')[1];
        if (timeSpan) {
          const parts = timeSpan.textContent.split('–').map(s => s.trim());
          if (parts.length === 2) weekTotal += calcHoursJS(parts[0], parts[1]);
        }
      }
    });
    const hoursCell = row.querySelector('td:last-child');
    if (hoursCell) {
      const otherMonthHours = parseFloat(hoursCell.dataset.otherMonthHours || 0);
      const contracted = parseFloat(hoursCell.dataset.contracted || 0);
      const total = weekTotal + otherMonthHours;
      const pct = contracted > 0 ? Math.min(100, (total / contracted) * 100) : 0;
      const mainSpan = hoursCell.querySelector('.text-sm.font-semibold');
      if (mainSpan) {
        mainSpan.textContent = formatHoursJS(total);
        mainSpan.className = `text-sm font-semibold ${total >= contracted && contracted > 0 ? 'text-emerald-600' : 'text-slate-700'}`;
      }
      const bar = hoursCell.querySelector('.progress-bar');
      if (bar) {
        bar.style.width = pct + '%';
        bar.className = `progress-bar h-1.5 rounded-full ${total >= contracted ? 'bg-emerald-500' : 'bg-blue-500'}`;
      }
    }
  });
}

function calcHoursJS(start, end) {
  const [sh, sm] = start.split(':').map(Number);
  const [eh, em] = end.split(':').map(Number);
  let m = (eh * 60 + em) - (sh * 60 + sm);
  if (m < 0) m += 24 * 60;
  return m / 60;
}

function formatHoursJS(h) {
  if (!h) return '0h';
  const hours = Math.floor(h);
  const mins = Math.round((h - hours) * 60);
  return mins > 0 ? `${hours}h ${mins}m` : `${hours}h`;
}

function showToast(msg, type) {
  const div = document.createElement('div');
  div.className = `fixed bottom-6 left-1/2 -translate-x-1/2 px-4 py-3 rounded-xl shadow-lg text-sm font-medium z-50 transition-all ${type === 'error' ? 'bg-red-600 text-white' : 'bg-emerald-600 text-white'}`;
  div.textContent = msg;
  document.body.appendChild(div);
  setTimeout(() => div.remove(), 3500);
}

// Drag-and-drop via event delegation on the table
(function () {
  const table = document.getElementById('scheduleTable');
  if (!table || table.dataset.editable !== 'true') return;

  table.addEventListener('dragover', function (e) {
    const cell = e.target.closest('.schedule-cell');
    if (!cell) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    cell.classList.add('drag-over');
  });

  table.addEventListener('dragleave', function (e) {
    const cell = e.target.closest('.schedule-cell');
    if (!cell || cell.contains(e.relatedTarget)) return;
    cell.classList.remove('drag-over');
  });

  table.addEventListener('drop', function (e) {
    const cell = e.target.closest('.schedule-cell');
    if (!cell) return;
    e.preventDefault();
    handleDrop(e, cell);
  });
})();

document.addEventListener('keydown', e => {
  if (e.key === 'Escape') { closeAddShift(); closeProposeModal(); }
});
document.getElementById('addShiftModal').addEventListener('click', e => {
  if (e.target === document.getElementById('addShiftModal')) closeAddShift();
});
const _proposeModal = document.getElementById('proposeModal');
if (_proposeModal) _proposeModal.addEventListener('click', e => { if (e.target === _proposeModal) closeProposeModal(); });

// ── Auto-propose ──────────────────────────────────────────────────────────────

let _currentProposals = [];

const _strategyLabels = {
  min_cost: '💰 Minimalne koszty',
  fill_min_hours: '📋 Uzupełnij min. godzin',
  fair_share: '⚖ Równy podział zmian',
};
const _dayNamesShort = ['Pon', 'Wt', 'Śr', 'Czw', 'Pt', 'Sob', 'Nd'];
const _monthNamesShort = ['sty', 'lut', 'mar', 'kwi', 'maj', 'cze', 'lip', 'sie', 'wrz', 'paź', 'lis', 'gru'];

async function proposeShifts(event) {
  if (!_scheduleDbId) { showToast('Brak aktywnego grafiku.', 'error'); return; }
  const strategy = document.getElementById('proposeStrategy').value;
  const btn = event?.currentTarget;
  if (btn) { btn.disabled = true; btn.textContent = '...'; }

  try {
    const res = await fetch('/api/schedule/propose', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ weekStart: _scheduleWeekStart, scheduleId: _scheduleDbId, strategy }),
    });
    const data = await res.json();
    if (!res.ok) { showToast(data.error || 'Błąd generowania propozycji.', 'error'); return; }
    if (!data.proposals?.length) {
      showToast('Brak propozycji — nikt nie jest dostępny lub wszystkie komórki są już wypełnione.', 'error');
      return;
    }
    _currentProposals = data.proposals;
    _renderProposals(data.proposals, strategy);
    document.getElementById('proposeModal').classList.remove('hidden');
  } catch (e) {
    showToast('Błąd sieci.', 'error');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '✨ Zaproponuj'; }
  }
}

function closeProposeModal() {
  const m = document.getElementById('proposeModal');
  if (m) m.classList.add('hidden');
  _currentProposals = [];
}

function _renderProposals(proposals, strategy) {
  document.getElementById('proposeSubtitle').textContent =
    `${proposals.length} propozycji · ${_strategyLabels[strategy] || strategy}`;
  document.getElementById('applyProposalsBtn').textContent = `Zastosuj wszystkie (${proposals.length})`;

  const byDate = {};
  for (const p of proposals) { if (!byDate[p.date]) byDate[p.date] = []; byDate[p.date].push(p); }

  const content = document.getElementById('proposeContent');
  content.innerHTML = '';

  for (const [date, entries] of Object.entries(byDate)) {
    const d = new Date(date + 'T00:00:00');
    const dayIdx = d.getDay() === 0 ? 6 : d.getDay() - 1;
    const label = `${_dayNamesShort[dayIdx]} ${d.getDate()} ${_monthNamesShort[d.getMonth()]}`;

    const sec = document.createElement('div');
    sec.innerHTML = `
      <div class="text-[11px] font-semibold text-slate-400 uppercase tracking-wide mb-1.5">${label}</div>
      <div class="rounded-xl border border-slate-200 overflow-hidden divide-y divide-slate-100">
        ${entries.map(p => `
          <div class="flex items-center gap-3 px-3 py-2">
            <span class="w-2.5 h-2.5 rounded-full flex-shrink-0" style="background:${p.color}"></span>
            <span class="font-medium text-slate-800 flex-1 text-sm truncate">${p.userName}</span>
            <span class="text-slate-500 text-xs">${p.shiftName}</span>
            <span class="text-slate-400 text-xs whitespace-nowrap">${p.startTime}–${p.endTime}</span>
          </div>
        `).join('')}
      </div>`;
    content.appendChild(sec);
  }
}

async function applyProposals() {
  const btn = document.getElementById('applyProposalsBtn');
  btn.disabled = true;
  btn.textContent = 'Dodawanie...';

  let added = 0, failed = 0;
  for (const p of _currentProposals) {
    try {
      const res = await fetch('/api/schedule/entry', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scheduleId: _scheduleDbId, userId: p.userId, date: p.date, shiftTemplateId: p.shiftTemplateId }),
      });
      const data = await res.json();
      if (res.ok) { addEntryToCell(data.entry, String(_scheduleDbId)); added++; }
      else failed++;
    } catch { failed++; }
  }

  closeProposeModal();
  updateHoursRow();

  if (failed === 0) showToast(`Dodano ${added} zmian.`);
  else if (added > 0) showToast(`Dodano ${added} zmian, ${failed} pominięto (konflikt).`);
  else showToast('Nie udało się dodać żadnej zmiany.', 'error');
}
