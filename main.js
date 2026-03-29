const { app, BrowserWindow, Tray, Menu, ipcMain, dialog, powerSaveBlocker } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFile, spawn } = require('child_process');

// ── State ──────────────────────────────────────────────────────────────────────
let mainWindow = null;
let tray = null;
let powerSaveId = null;
let pollInterval = null;
let isAwake = false;
let manualAwake = false;
let runningWatchedApps = [];
let activeIntegrations = [];
let config = { manualAwake: false, watchedApps: [], watchedIntegrations: [] };

const CONFIG_PATH = path.join(app.getPath('userData'), 'config.json');
const ASSETS = path.join(__dirname, 'assets');
const HOOK_SCRIPT = path.join(__dirname, 'agent-hook.js');
const SESSIONS_DIR = path.join(os.homedir(), '.insomnia');
const SESSIONS_FILE = path.join(SESSIONS_DIR, 'agent-sessions.json');
const SESSION_TIMEOUT_MS = 90 * 1000; // 90 seconds — tool calls refresh every few seconds while active

// ── Available Integrations ─────────────────────────────────────────────────────
const INTEGRATIONS = [
  {
    id: 'claude-code',
    name: 'Claude Code',
    description: 'Keeps PC awake while Claude is actively working on tasks',
    hookBased: true,
    icon: 'claude'
  },
  {
    id: 'aider',
    name: 'Aider',
    description: 'AI pair programming in your terminal',
    hookBased: false,
    processNames: ['aider.exe', 'aider'],
    icon: 'aider'
  },
  {
    id: 'codex-cli',
    name: 'OpenAI Codex CLI',
    description: 'OpenAI\'s coding agent in the terminal',
    hookBased: false,
    processNames: ['codex.exe', 'codex'],
    icon: 'codex'
  },
  {
    id: 'ollama',
    name: 'Ollama',
    description: 'Local AI model server — stay awake during inference',
    hookBased: false,
    processNames: ['ollama.exe', 'ollama_llama_server.exe'],
    icon: 'ollama'
  }
];

// ── Config ─────────────────────────────────────────────────────────────────────
function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    }
  } catch {}
  if (!config.watchedApps) config.watchedApps = [];
  if (!config.watchedIntegrations) config.watchedIntegrations = [];
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
  const shouldBeAwake = manualAwake || runningWatchedApps.length > 0 || activeIntegrations.length > 0;
  if (shouldBeAwake && !isAwake) {
    startCaffeinating();
  } else if (!shouldBeAwake && isAwake) {
    stopCaffeinating();
  } else {
    updateTray();
    notifyRenderer();
  }
}

// ── Process Monitoring ─────────────────────────────────────────────────────────
function checkRunningProcesses() {
  // Collect all process names to check (apps + process-based integrations)
  const enabledApps = config.watchedApps.filter(a => a.enabled);
  const processIntegrations = config.watchedIntegrations
    .filter(i => i.enabled)
    .map(i => INTEGRATIONS.find(def => def.id === i.id))
    .filter(def => def && !def.hookBased && def.processNames);

  const needsTasklist = enabledApps.length > 0 || processIntegrations.length > 0;

  if (!needsTasklist) {
    runningWatchedApps = [];
    // Still check hook-based integrations
    checkAgentSessions();
    return;
  }

  const proc = spawn('tasklist', { stdio: 'pipe', shell: true, windowsHide: true });
  let output = '';
  proc.stdout.on('data', d => { output += d.toString(); });
  proc.on('close', () => {
    const lower = output.toLowerCase();

    // Check apps
    runningWatchedApps = enabledApps.filter(a => lower.includes(a.exe.toLowerCase()));

    // Check process-based integrations
    for (const def of processIntegrations) {
      const isRunning = def.processNames.some(p => lower.includes(p.toLowerCase()));
      if (isRunning) {
        if (!activeIntegrations.find(a => a.id === def.id)) {
          activeIntegrations.push({ id: def.id, name: def.name, reason: 'process' });
        }
      } else {
        activeIntegrations = activeIntegrations.filter(a => !(a.id === def.id && a.reason === 'process'));
      }
    }

    checkAgentSessions();
  });
  proc.on('error', () => {
    runningWatchedApps = [];
    checkAgentSessions();
  });
}

// ── Agent Session Monitoring (Hook-based integrations) ─────────────────────────
function checkAgentSessions() {
  const hookIntegrations = config.watchedIntegrations
    .filter(i => i.enabled)
    .map(i => INTEGRATIONS.find(def => def.id === i.id))
    .filter(def => def && def.hookBased);

  // Remove stale hook-based entries
  activeIntegrations = activeIntegrations.filter(a => a.reason !== 'hook');

  if (hookIntegrations.length === 0) {
    evaluateState();
    return;
  }

  try {
    if (!fs.existsSync(SESSIONS_FILE)) {
      evaluateState();
      return;
    }

    const data = JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8'));
    const now = Date.now();

    for (const def of hookIntegrations) {
      // Check if any session for this integration is active
      const hasActive = Object.values(data.sessions || {}).some(s => {
        if (s.integration !== def.id) return false;
        const lastActivity = new Date(s.last_activity).getTime();
        return (now - lastActivity) < SESSION_TIMEOUT_MS;
      });

      if (hasActive) {
        activeIntegrations.push({ id: def.id, name: def.name, reason: 'hook' });
      }
    }
  } catch {}

  evaluateState();
}

// ── Claude Code Hook Setup ─────────────────────────────────────────────────────
function getClaudeSettingsPath() {
  return path.join(os.homedir(), '.claude', 'settings.json');
}

function setupClaudeCodeHooks() {
  const settingsPath = getClaudeSettingsPath();
  let settings = {};

  try {
    if (fs.existsSync(settingsPath)) {
      settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    }
  } catch {}

  if (!settings.hooks) settings.hooks = {};

  const nodeExe = process.execPath.includes('electron')
    ? 'node'
    : process.execPath;

  const cafCmd = `node "${HOOK_SCRIPT}" caffeinate claude-code`;
  const uncafCmd = `node "${HOOK_SCRIPT}" uncaffeinate claude-code`;

  const cafHook = { hooks: [{ type: 'command', command: cafCmd }] };
  const uncafHook = { hooks: [{ type: 'command', command: uncafCmd }] };

  // Remove any existing cc-caffeine hooks and add ours
  const cafEvents = ['UserPromptSubmit', 'PreToolUse', 'PostToolUse'];
  const uncafEvents = ['Notification', 'Stop', 'SessionEnd'];

  for (const event of cafEvents) {
    if (!settings.hooks[event]) settings.hooks[event] = [];
    // Remove cc-caffeine hooks
    settings.hooks[event] = settings.hooks[event].filter(h =>
      !h.hooks?.some(hh => hh.command?.includes('cc-caffeine'))
    );
    // Remove existing Insomnia hooks
    settings.hooks[event] = settings.hooks[event].filter(h =>
      !h.hooks?.some(hh => hh.command?.includes('agent-hook.js'))
    );
    settings.hooks[event].push(cafHook);
  }

  for (const event of uncafEvents) {
    if (!settings.hooks[event]) settings.hooks[event] = [];
    settings.hooks[event] = settings.hooks[event].filter(h =>
      !h.hooks?.some(hh => hh.command?.includes('cc-caffeine'))
    );
    settings.hooks[event] = settings.hooks[event].filter(h =>
      !h.hooks?.some(hh => hh.command?.includes('agent-hook.js'))
    );
    settings.hooks[event].push(uncafHook);
  }

  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
}

function removeClaudeCodeHooks() {
  const settingsPath = getClaudeSettingsPath();
  try {
    if (!fs.existsSync(settingsPath)) return;
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    if (!settings.hooks) return;

    for (const event of Object.keys(settings.hooks)) {
      settings.hooks[event] = settings.hooks[event].filter(h =>
        !h.hooks?.some(hh => hh.command?.includes('agent-hook.js'))
      );
      if (settings.hooks[event].length === 0) {
        delete settings.hooks[event];
      }
    }

    if (Object.keys(settings.hooks).length === 0) {
      delete settings.hooks;
    }

    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
  } catch {}
}

// ── Tray ───────────────────────────────────────────────────────────────────────
function getTooltip() {
  if (!isAwake) return 'Inactive';

  const reasons = [];
  if (manualAwake) reasons.push('Manual mode');
  if (runningWatchedApps.length > 0) {
    reasons.push(runningWatchedApps.map(a => a.name).join(', '));
  }
  if (activeIntegrations.length > 0) {
    reasons.push(activeIntegrations.map(a => a.name).join(', '));
  }
  return 'Staying awake for \u2014 ' + reasons.join(', ');
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
      $shell = New-Object -ComObject WScript.Shell
      $apps = @{}

      $lnkPaths = @(
        [Environment]::GetFolderPath('CommonStartMenu') + '\\Programs',
        [Environment]::GetFolderPath('StartMenu') + '\\Programs'
      )
      foreach ($dir in $lnkPaths) {
        if (Test-Path $dir) {
          Get-ChildItem -Path $dir -Filter '*.lnk' -Recurse -ErrorAction SilentlyContinue | ForEach-Object {
            try {
              $shortcut = $shell.CreateShortcut($_.FullName)
              $target = $shortcut.TargetPath
              if ($target -and $target -match '\\.exe$' -and (Test-Path $target -ErrorAction SilentlyContinue)) {
                $name = [System.IO.Path]::GetFileNameWithoutExtension($_.Name)
                $key = $target.ToLower()
                if (-not $apps.ContainsKey($key)) {
                  $apps[$key] = @{ name = $name; exe = $target }
                }
              }
            } catch {}
          }
        }
      }

      $regPaths = @(
        'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*',
        'HKLM:\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*',
        'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*'
      )
      foreach ($p in $regPaths) {
        try {
          Get-ItemProperty $p -ErrorAction SilentlyContinue |
            Where-Object { $_.DisplayName } |
            ForEach-Object {
              $exe = ''
              if ($_.DisplayIcon -and $_.DisplayIcon -match '(?i)^(.+?\\.exe)') {
                $exe = $Matches[1]
              } elseif ($_.InstallLocation -and (Test-Path $_.InstallLocation -ErrorAction SilentlyContinue)) {
                $found = Get-ChildItem -Path $_.InstallLocation -Filter '*.exe' -Depth 1 -ErrorAction SilentlyContinue | Select-Object -First 1
                if ($found) { $exe = $found.FullName }
              }
              if ($exe -and (Test-Path $exe -ErrorAction SilentlyContinue)) {
                $key = $exe.ToLower()
                if (-not $apps.ContainsKey($key)) {
                  $apps[$key] = @{ name = $_.DisplayName; exe = $exe }
                }
              }
            }
        } catch {}
      }

      try {
        Get-AppxPackage -ErrorAction SilentlyContinue |
          Where-Object { $_.IsFramework -eq $false -and $_.SignatureKind -eq 'Store' } |
          ForEach-Object {
            try {
              $manifest = Join-Path $_.InstallLocation 'AppxManifest.xml'
              if (Test-Path $manifest) {
                [xml]$xml = Get-Content $manifest -ErrorAction SilentlyContinue
                $displayName = $xml.Package.Properties.DisplayName
                $exeName = $xml.Package.Applications.Application.Executable
                if ($displayName -and $exeName) {
                  $fullExe = Join-Path $_.InstallLocation $exeName
                  if (Test-Path $fullExe -ErrorAction SilentlyContinue) {
                    $key = $fullExe.ToLower()
                    if (-not $apps.ContainsKey($key)) {
                      $apps[$key] = @{ name = $displayName; exe = $fullExe }
                    }
                  }
                }
              }
            } catch {}
          }
      } catch {}

      $desktopPaths = @(
        [Environment]::GetFolderPath('Desktop'),
        [Environment]::GetFolderPath('CommonDesktopDirectory')
      )
      foreach ($dir in $desktopPaths) {
        if (Test-Path $dir) {
          Get-ChildItem -Path $dir -Filter '*.lnk' -ErrorAction SilentlyContinue | ForEach-Object {
            try {
              $shortcut = $shell.CreateShortcut($_.FullName)
              $target = $shortcut.TargetPath
              if ($target -and $target -match '\\.exe$' -and (Test-Path $target -ErrorAction SilentlyContinue)) {
                $name = [System.IO.Path]::GetFileNameWithoutExtension($_.Name)
                $key = $target.ToLower()
                if (-not $apps.ContainsKey($key)) {
                  $apps[$key] = @{ name = $name; exe = $target }
                }
              }
            } catch {}
          }
        }
      }

      $apps.Values | Sort-Object { $_.name } | ConvertTo-Json -Compress
    `;

    execFile('powershell', ['-NoProfile', '-Command', psScript], {
      windowsHide: true,
      maxBuffer: 10 * 1024 * 1024,
      timeout: 30000
    }, (err, stdout) => {
      if (err) { resolve([]); return; }
      try {
        const trimmed = stdout.trim();
        if (!trimmed) { resolve([]); return; }
        let parsed = JSON.parse(trimmed);
        if (!Array.isArray(parsed)) parsed = [parsed];
        const seen = new Set();
        const unique = [];
        for (const a of parsed) {
          if (!a.name || !a.exe) continue;
          const key = path.basename(a.exe).toLowerCase();
          if (!seen.has(key)) {
            seen.add(key);
            unique.push({ name: a.name, exe: a.exe, exeName: path.basename(a.exe) });
          }
        }
        unique.sort((a, b) => a.name.localeCompare(b.name));
        resolve(unique);
      } catch { resolve([]); }
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
    watchedIntegrations: config.watchedIntegrations,
    runningWatchedApps: runningWatchedApps.map(a => a.exe),
    activeIntegrations: activeIntegrations.map(a => a.id),
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

  // App management
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

  // Integration management
  ipcMain.handle('get-available-integrations', () => {
    return INTEGRATIONS.map(def => ({
      ...def,
      enabled: config.watchedIntegrations.some(i => i.id === def.id && i.enabled),
      added: config.watchedIntegrations.some(i => i.id === def.id)
    }));
  });

  ipcMain.handle('add-integration', (_, integrationId) => {
    const def = INTEGRATIONS.find(d => d.id === integrationId);
    if (!def) return getStatus();

    const exists = config.watchedIntegrations.find(i => i.id === integrationId);
    if (!exists) {
      config.watchedIntegrations.push({ id: def.id, name: def.name, enabled: true });
    }

    // Setup hooks if hook-based
    if (def.hookBased && integrationId === 'claude-code') {
      setupClaudeCodeHooks();
    }

    saveConfig();
    checkRunningProcesses();
    return getStatus();
  });

  ipcMain.handle('remove-integration', (_, integrationId) => {
    const def = INTEGRATIONS.find(d => d.id === integrationId);
    config.watchedIntegrations = config.watchedIntegrations.filter(i => i.id !== integrationId);

    // Remove hooks if hook-based
    if (def?.hookBased && integrationId === 'claude-code') {
      removeClaudeCodeHooks();
    }

    activeIntegrations = activeIntegrations.filter(a => a.id !== integrationId);
    saveConfig();
    evaluateState();
    return getStatus();
  });

  ipcMain.handle('toggle-integration', (_, integrationId) => {
    const found = config.watchedIntegrations.find(i => i.id === integrationId);
    if (found) {
      found.enabled = !found.enabled;
      const def = INTEGRATIONS.find(d => d.id === integrationId);
      if (def?.hookBased && integrationId === 'claude-code') {
        if (found.enabled) setupClaudeCodeHooks();
        else removeClaudeCodeHooks();
      }
      if (!found.enabled) {
        activeIntegrations = activeIntegrations.filter(a => a.id !== integrationId);
      }
      saveConfig();
      checkRunningProcesses();
    }
    return getStatus();
  });

  // App discovery
  ipcMain.handle('get-installed-apps', async () => {
    const apps = await discoverInstalledApps();
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
    height: 680,
    resizable: false,
    maximizable: false,
    icon: path.join(ASSETS, 'icon.png'),
    title: 'Insomnia',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  mainWindow.loadFile('index.html');
  mainWindow.setMenuBarVisibility(false);

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
  // Ensure sessions directory exists
  if (!fs.existsSync(SESSIONS_DIR)) {
    fs.mkdirSync(SESSIONS_DIR, { recursive: true });
  }

  loadConfig();
  setupIPC();
  createWindow();
  createTray();

  checkRunningProcesses();
  pollInterval = setInterval(checkRunningProcesses, 10000);

  if (manualAwake) evaluateState();
});

app.on('window-all-closed', () => {
  // Don't quit — we live in the tray
});
