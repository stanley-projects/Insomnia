const { app, BrowserWindow, Tray, Menu, ipcMain, dialog, powerSaveBlocker, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
const { execFile, spawn } = require('child_process');

// ── State ──────────────────────────────────────────────────────────────────────
let mainWindow = null;
let tray = null;
let powerSaveId = null;
let pollInterval = null;
let isAwake = false;
let manualAwake = false;
let runningWatchedApps = [];
let config = { manualAwake: false, watchedApps: [] };

const CONFIG_PATH = path.join(app.getPath('userData'), 'config.json');
const ASSETS = path.join(__dirname, 'assets');

// ── Config ─────────────────────────────────────────────────────────────────────
function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    }
  } catch {
    config = { manualAwake: false, watchedApps: [] };
  }
  manualAwake = config.manualAwake || false;
}

function saveConfig() {
  config.manualAwake = manualAwake;
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
}

// ── Power Management ───────────────────────────────────────────────────────────
function startCaffeinating() {
  if (powerSaveId === null) {
    powerSaveId = powerSaveBlocker.start('prevent-app-suspension');
  }
  isAwake = true;
  updateTray();
  notifyRenderer();
}

function stopCaffeinating() {
  if (powerSaveId !== null) {
    powerSaveBlocker.stop(powerSaveId);
    powerSaveId = null;
  }
  isAwake = false;
  updateTray();
  notifyRenderer();
}

function evaluateState() {
  const shouldBeAwake = manualAwake || runningWatchedApps.length > 0;
  if (shouldBeAwake && !isAwake) {
    startCaffeinating();
  } else if (!shouldBeAwake && isAwake) {
    stopCaffeinating();
  } else if (isAwake) {
    // State unchanged but reasons may have changed — update tray/renderer
    updateTray();
    notifyRenderer();
  }
}

// ── Process Monitoring ─────────────────────────────────────────────────────────
function checkRunningProcesses() {
  const enabledApps = config.watchedApps.filter(a => a.enabled);
  if (enabledApps.length === 0 && !manualAwake) {
    runningWatchedApps = [];
    evaluateState();
    return;
  }

  if (enabledApps.length === 0) {
    runningWatchedApps = [];
    evaluateState();
    return;
  }

  const proc = spawn('tasklist', { stdio: 'pipe', shell: true, windowsHide: true });
  let output = '';
  proc.stdout.on('data', d => { output += d.toString(); });
  proc.on('close', () => {
    const lower = output.toLowerCase();
    runningWatchedApps = enabledApps.filter(a => lower.includes(a.exe.toLowerCase()));
    evaluateState();
  });
  proc.on('error', () => {
    runningWatchedApps = [];
    evaluateState();
  });
}

// ── Tray ───────────────────────────────────────────────────────────────────────
function getTooltip() {
  if (!isAwake) return 'Inactive';

  const reasons = [];
  if (manualAwake) reasons.push('Manual mode');
  if (runningWatchedApps.length > 0) {
    reasons.push(runningWatchedApps.map(a => a.name).join(', ') + ' running');
  }
  return 'Caffeinating \u2014 ' + reasons.join(' + ');
}

function updateTray() {
  if (!tray) return;
  const iconFile = isAwake ? 'tray-active.png' : 'tray-inactive.png';
  tray.setImage(path.join(ASSETS, iconFile));
  tray.setToolTip(getTooltip());
}

function createTray() {
  tray = new Tray(path.join(ASSETS, 'tray-inactive.png'));
  tray.setToolTip('Inactive');

  const contextMenu = Menu.buildFromTemplate([
    { label: 'Show Insomnia', click: () => { mainWindow.show(); } },
    { type: 'separator' },
    {
      label: 'Toggle Awake',
      click: () => {
        manualAwake = !manualAwake;
        saveConfig();
        evaluateState();
      }
    },
    { type: 'separator' },
    {
      label: 'Exit',
      click: () => {
        if (powerSaveId !== null) {
          powerSaveBlocker.stop(powerSaveId);
          powerSaveId = null;
        }
        app.quit();
      }
    }
  ]);
  tray.setContextMenu(contextMenu);
  tray.on('double-click', () => { mainWindow.show(); });
}

// ── App Discovery ──────────────────────────────────────────────────────────────
function discoverInstalledApps() {
  return new Promise((resolve) => {
    const psScript = `
      $apps = @()

      # Registry apps (64-bit + 32-bit + user)
      $regPaths = @(
        'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*',
        'HKLM:\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*',
        'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*'
      )
      foreach ($p in $regPaths) {
        try {
          Get-ItemProperty $p -ErrorAction SilentlyContinue |
            Where-Object { $_.DisplayName -and ($_.InstallLocation -or $_.DisplayIcon) } |
            ForEach-Object {
              $exe = ''
              if ($_.DisplayIcon -and $_.DisplayIcon -match '(?i)^(.+\\.exe)') {
                $exe = $Matches[1]
              } elseif ($_.InstallLocation) {
                $found = Get-ChildItem -Path $_.InstallLocation -Filter '*.exe' -ErrorAction SilentlyContinue | Select-Object -First 1
                if ($found) { $exe = $found.FullName }
              }
              if ($exe -and (Test-Path $exe -ErrorAction SilentlyContinue)) {
                $apps += @{ name = $_.DisplayName; exe = $exe }
              }
            }
        } catch {}
      }

      # Store apps
      try {
        Get-AppxPackage -ErrorAction SilentlyContinue |
          Where-Object { $_.IsFramework -eq $false -and $_.SignatureKind -eq 'Store' } |
          ForEach-Object {
            $manifest = Join-Path $_.InstallLocation 'AppxManifest.xml'
            if (Test-Path $manifest) {
              [xml]$xml = Get-Content $manifest -ErrorAction SilentlyContinue
              $displayName = $xml.Package.Properties.DisplayName
              $exeName = $xml.Package.Applications.Application.Executable
              if ($displayName -and $exeName) {
                $fullExe = Join-Path $_.InstallLocation $exeName
                if (Test-Path $fullExe -ErrorAction SilentlyContinue) {
                  $apps += @{ name = $displayName; exe = $fullExe }
                }
              }
            }
          }
      } catch {}

      $apps | Sort-Object { $_.name } -Unique | ConvertTo-Json -Compress
    `;

    execFile('powershell', ['-NoProfile', '-Command', psScript], {
      windowsHide: true,
      maxBuffer: 10 * 1024 * 1024
    }, (err, stdout) => {
      if (err) {
        resolve([]);
        return;
      }
      try {
        let parsed = JSON.parse(stdout.trim());
        if (!Array.isArray(parsed)) parsed = [parsed];
        // Deduplicate by exe name
        const seen = new Set();
        const unique = [];
        for (const a of parsed) {
          const key = path.basename(a.exe).toLowerCase();
          if (!seen.has(key)) {
            seen.add(key);
            unique.push({ name: a.name, exe: a.exe, exeName: path.basename(a.exe) });
          }
        }
        resolve(unique);
      } catch {
        resolve([]);
      }
    });
  });
}

async function getAppIcon(exePath) {
  try {
    const icon = await app.getFileIcon(exePath, { size: 'large' });
    return icon.toDataURL();
  } catch {
    return null;
  }
}

// ── Renderer Communication ─────────────────────────────────────────────────────
function notifyRenderer() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('status-update', getStatus());
  }
}

function getStatus() {
  return {
    isAwake,
    manualAwake,
    watchedApps: config.watchedApps,
    runningWatchedApps: runningWatchedApps.map(a => a.exe),
    tooltip: getTooltip()
  };
}

// ── IPC Handlers ───────────────────────────────────────────────────────────────
function setupIPC() {
  ipcMain.handle('get-status', () => getStatus());

  ipcMain.handle('toggle-awake', () => {
    manualAwake = !manualAwake;
    saveConfig();
    evaluateState();
    return getStatus();
  });

  ipcMain.handle('add-app', (_, appData) => {
    const exists = config.watchedApps.some(a => a.exe.toLowerCase() === appData.exe.toLowerCase());
    if (!exists) {
      config.watchedApps.push({ name: appData.name, exe: appData.exe, enabled: true });
      saveConfig();
      checkRunningProcesses();
    }
    return getStatus();
  });

  ipcMain.handle('remove-app', (_, exe) => {
    config.watchedApps = config.watchedApps.filter(a => a.exe.toLowerCase() !== exe.toLowerCase());
    saveConfig();
    checkRunningProcesses();
    return getStatus();
  });

  ipcMain.handle('toggle-app', (_, exe) => {
    const found = config.watchedApps.find(a => a.exe.toLowerCase() === exe.toLowerCase());
    if (found) {
      found.enabled = !found.enabled;
      saveConfig();
      checkRunningProcesses();
    }
    return getStatus();
  });

  ipcMain.handle('get-installed-apps', async () => {
    const apps = await discoverInstalledApps();
    // Fetch icons in batches to avoid overwhelming
    const results = [];
    for (const a of apps) {
      const icon = await getAppIcon(a.exe);
      results.push({ ...a, icon });
    }
    return results;
  });

  ipcMain.handle('browse-exe', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Select Application',
      filters: [{ name: 'Executables', extensions: ['exe'] }],
      properties: ['openFile']
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    const exePath = result.filePaths[0];
    const name = path.basename(exePath, '.exe');
    const icon = await getAppIcon(exePath);
    return { name, exe: exePath, icon };
  });
}

// ── Window ─────────────────────────────────────────────────────────────────────
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 500,
    height: 650,
    resizable: false,
    maximizable: false,
    icon: path.join(ASSETS, 'tray-active.png'),
    title: 'Insomnia',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  mainWindow.loadFile('index.html');
  mainWindow.setMenuBarVisibility(false);

  // Minimize to tray instead of closing
  mainWindow.on('close', (e) => {
    if (!app.isQuitting) {
      e.preventDefault();
      mainWindow.hide();
    }
  });
}

// ── App Lifecycle ──────────────────────────────────────────────────────────────
app.on('before-quit', () => {
  app.isQuitting = true;
  if (pollInterval) clearInterval(pollInterval);
  if (powerSaveId !== null) {
    powerSaveBlocker.stop(powerSaveId);
    powerSaveId = null;
  }
});

app.whenReady().then(() => {
  loadConfig();
  setupIPC();
  createWindow();
  createTray();

  // Initial check and start polling
  checkRunningProcesses();
  pollInterval = setInterval(checkRunningProcesses, 10000);

  // If manual awake was saved, restore it
  if (manualAwake) evaluateState();
});

app.on('window-all-closed', () => {
  // Don't quit — we live in the tray
});
