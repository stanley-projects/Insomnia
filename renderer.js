// ── Elements ───────────────────────────────────────────────────────────────────
const statusDot = document.getElementById('statusDot');
const statusText = document.getElementById('statusText');
const manualToggle = document.getElementById('manualToggle');
const reasonText = document.getElementById('reasonText');
const watchList = document.getElementById('watchList');
const emptyMessage = document.getElementById('emptyMessage');
const addAppBtn = document.getElementById('addAppBtn');
const drawerOverlay = document.getElementById('drawerOverlay');
const drawerClose = document.getElementById('drawerClose');
const searchInput = document.getElementById('searchInput');
const appGrid = document.getElementById('appGrid');
const drawerLoading = document.getElementById('drawerLoading');
const browseBtn = document.getElementById('browseBtn');

let installedApps = [];

// ── UI Updates ─────────────────────────────────────────────────────────────────
function updateUI(status) {
  // Status indicator
  statusDot.className = 'status-dot' + (status.isAwake ? ' active' : '');
  statusText.className = 'status-text' + (status.isAwake ? ' active' : '');
  statusText.textContent = status.isAwake ? 'Caffeinating' : 'Inactive';

  // Manual toggle
  manualToggle.checked = status.manualAwake;

  // Reason text
  if (status.isAwake) {
    const reasons = [];
    if (status.manualAwake) reasons.push('Manual mode');
    if (status.runningWatchedApps.length > 0) {
      const names = status.watchedApps
        .filter(a => status.runningWatchedApps.some(r => r.toLowerCase() === a.exe.toLowerCase()))
        .map(a => a.name);
      if (names.length > 0) reasons.push(names.join(', ') + ' running');
    }
    reasonText.textContent = reasons.join(' + ') || 'Keeping awake';
  } else {
    reasonText.textContent = 'Manually prevent sleep';
  }

  // Watch list
  renderWatchList(status);
}

function renderWatchList(status) {
  const apps = status.watchedApps;

  if (apps.length === 0) {
    emptyMessage.style.display = 'block';
    // Remove all watch items but keep empty message
    const items = watchList.querySelectorAll('.watch-item');
    items.forEach(i => i.remove());
    return;
  }

  emptyMessage.style.display = 'none';

  // Clear existing items
  const items = watchList.querySelectorAll('.watch-item');
  items.forEach(i => i.remove());

  apps.forEach(app => {
    const isRunning = status.runningWatchedApps.some(r => r.toLowerCase() === app.exe.toLowerCase());
    const el = document.createElement('div');
    el.className = 'watch-item';
    el.innerHTML = `
      <div class="watch-item-running ${isRunning ? 'active' : ''}"></div>
      <div class="watch-item-info">
        <div class="watch-item-name">${escapeHtml(app.name)}</div>
        <div class="watch-item-exe">${escapeHtml(app.exe)}</div>
      </div>
      <label class="switch" style="transform: scale(0.8);">
        <input type="checkbox" ${app.enabled ? 'checked' : ''}>
        <span class="slider"></span>
      </label>
      <button class="btn-remove">&times;</button>
    `;

    // Toggle app
    const toggle = el.querySelector('input[type="checkbox"]');
    toggle.addEventListener('change', () => {
      window.insomnia.toggleApp(app.exe);
    });

    // Remove app
    const removeBtn = el.querySelector('.btn-remove');
    removeBtn.addEventListener('click', () => {
      window.insomnia.removeApp(app.exe);
    });

    watchList.appendChild(el);
  });
}

// ── Manual Toggle ──────────────────────────────────────────────────────────────
manualToggle.addEventListener('change', () => {
  window.insomnia.toggleAwake();
});

// ── App Drawer ─────────────────────────────────────────────────────────────────
addAppBtn.addEventListener('click', openDrawer);
drawerClose.addEventListener('click', closeDrawer);
drawerOverlay.addEventListener('click', (e) => {
  if (e.target === drawerOverlay) closeDrawer();
});

async function openDrawer() {
  drawerOverlay.classList.add('open');
  searchInput.value = '';
  appGrid.innerHTML = '';
  drawerLoading.style.display = 'flex';

  try {
    installedApps = await window.insomnia.getInstalledApps();
    drawerLoading.style.display = 'none';
    renderAppGrid(installedApps);
    searchInput.focus();
  } catch {
    drawerLoading.innerHTML = '<span>Failed to load apps</span>';
  }
}

function closeDrawer() {
  drawerOverlay.classList.remove('open');
}

function renderAppGrid(apps) {
  appGrid.innerHTML = '';
  apps.forEach(app => {
    const el = document.createElement('div');
    el.className = 'app-grid-item';

    const iconHtml = app.icon
      ? `<img src="${app.icon}" alt="">`
      : `<div class="app-placeholder-icon">${app.name.charAt(0).toUpperCase()}</div>`;

    el.innerHTML = `
      ${iconHtml}
      <span>${escapeHtml(app.name)}</span>
    `;

    el.addEventListener('click', async () => {
      await window.insomnia.addApp({ name: app.name, exe: app.exeName || app.exe });
      closeDrawer();
    });

    appGrid.appendChild(el);
  });
}

// Search filter
searchInput.addEventListener('input', () => {
  const query = searchInput.value.toLowerCase();
  const filtered = installedApps.filter(a =>
    a.name.toLowerCase().includes(query) ||
    a.exe.toLowerCase().includes(query)
  );
  renderAppGrid(filtered);
});

// Browse manually
browseBtn.addEventListener('click', async () => {
  const result = await window.insomnia.browseExe();
  if (result) {
    await window.insomnia.addApp({ name: result.name, exe: result.exe });
    closeDrawer();
  }
});

// ── Escape HTML ────────────────────────────────────────────────────────────────
function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// ── Listen for Updates ─────────────────────────────────────────────────────────
window.insomnia.onStatusUpdate(updateUI);

// Initial load
window.insomnia.getStatus().then(updateUI);
