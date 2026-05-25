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
  if (e.key === 'Escape') closeAddShift();
});
document.getElementById('addShiftModal').addEventListener('click', e => {
  if (e.target === document.getElementById('addShiftModal')) closeAddShift();
});
