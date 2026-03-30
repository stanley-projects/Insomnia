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
// In production (asar), agent-hook.js is unpacked to app.asar.unpacked/
const HOOK_SCRIPT = app.isPackaged
  ? path.join(__dirname.replace('app.asar', 'app.asar.unpacked'), 'agent-hook.js')
  : path.join(__dirname, 'agent-hook.js');
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
    id: 'cursor',
    name: 'Cursor',
    description: 'Keeps PC awake while Cursor is running',
    hookBased: false,
    processNames: ['cursor.exe'],
    icon: 'cursor'
  },
  {
    id: 'aider',
    name: 'Aider',
    description: 'Keeps PC awake while Aider is running',
    hookBased: false,
    processNames: ['aider.exe', 'aider'],
    icon: 'aider'
  },
  {
    id: 'codex-cli',
    name: 'OpenAI Codex CLI',
    description: 'Keeps PC awake while Codex is running',
    hookBased: false,
    processNames: ['codex.exe', 'codex'],
    icon: 'codex'
  },
  {
    id: 'ollama',
    name: 'Ollama',
    description: 'Keeps PC awake while Ollama is running',
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
    powerSaveId = powerSaveBlocker.start('prevent-display-sleep');
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

// ── Session File Watcher (instant response to hook activity) ─────────────────
let sessionWatcher = null;
let watchDebounce = null;

function watchSessionFile() {
  // Ensure the directory and file exist before watching
  if (!fs.existsSync(SESSIONS_DIR)) {
    fs.mkdirSync(SESSIONS_DIR, { recursive: true });
  }
  if (!fs.existsSync(SESSIONS_FILE)) {
    fs.writeFileSync(SESSIONS_FILE, JSON.stringify({ sessions: {} }, null, 2));
  }

  try {
    sessionWatcher = fs.watch(SESSIONS_FILE, () => {
      // Debounce — hooks can fire in rapid succession
      if (watchDebounce) clearTimeout(watchDebounce);
      watchDebounce = setTimeout(() => {
        checkAgentSessions();
      }, 200);
    });

    sessionWatcher.on('error', () => {
      // File may be deleted/recreated — retry after a delay
      if (sessionWatcher) { sessionWatcher.close(); sessionWatcher = null; }
      setTimeout(watchSessionFile, 5000);
    });
  } catch {}
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
  const cafEvents = ['UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PermissionRequest'];
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

  // Try to promote tray icon to always-visible on Windows
  promoteTrayIcon();
}

function promoteTrayIcon() {
  // Windows stores tray icon visibility in registry under NotifyIconSettings.
  // We find our app's entry and set IsPromoted=1 to show it in the main tray area.
  const exePath = app.getPath('exe');
  const psScript = `
    $regPath = 'HKCU:\\Control Panel\\NotifyIconSettings'
    if (Test-Path $regPath) {
      Get-ChildItem $regPath -ErrorAction SilentlyContinue | ForEach-Object {
        $execPath = (Get-ItemProperty $_.PSPath -Name 'ExecutablePath' -ErrorAction SilentlyContinue).ExecutablePath
        if ($execPath -and $execPath -like '*Insomnia*') {
          Set-ItemProperty $_.PSPath -Name 'IsPromoted' -Value 1 -Type DWord -ErrorAction SilentlyContinue
        }
      }
    }
  `;
  execFile('powershell', ['-NoProfile', '-Command', psScript], { windowsHide: true }, () => {});
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

      # Executables that are updaters/wrappers and never have the real app icon
      $badExeNames = @('update.exe','uninstall.exe','uninst.exe','unins000.exe','squirrel.exe','chrome_proxy.exe','createdump.exe','crashpad_handler.exe','elevate.exe','notification_helper.exe')

      function Find-BestExe($displayName, $iconPath, $installLocation) {
        $exe = ''
        # Extract exe from DisplayIcon (may include args like "Update.exe --processStart Discord.exe")
        if ($iconPath) {
          # Try to grab the LAST .exe in the string (often the real app after --processStart)
          $allExes = [regex]::Matches($iconPath, '(?i)[\w\-. ]+\.exe')
          foreach ($m in ($allExes | Select-Object -Last 5)) {
            $candidate = $m.Value.Trim()
            if ($badExeNames -notcontains $candidate.ToLower()) {
              # Try to find this exe under the install location
              if ($installLocation -and (Test-Path $installLocation -ErrorAction SilentlyContinue)) {
                $found = Get-ChildItem -Path $installLocation -Filter $candidate -Recurse -Depth 3 -ErrorAction SilentlyContinue | Select-Object -First 1
                if ($found) { $exe = $found.FullName; break }
              }
            }
          }
          # Fallback: grab the first full path .exe from DisplayIcon
          if (-not $exe -and $iconPath -match '(?i)^"?([A-Za-z]:[^"]+\.exe)') {
            $candidate = $Matches[1]
            if ((Test-Path $candidate -ErrorAction SilentlyContinue) -and ($badExeNames -notcontains [System.IO.Path]::GetFileName($candidate).ToLower())) {
              $exe = $candidate
            }
          }
        }
        # Search install location for a well-named exe
        if (-not $exe -and $installLocation -and (Test-Path $installLocation -ErrorAction SilentlyContinue)) {
          # Prefer an exe whose name resembles the app display name
          $safeName = ($displayName -replace '[^a-zA-Z0-9]', '').ToLower()
          $candidates = Get-ChildItem -Path $installLocation -Filter '*.exe' -Recurse -Depth 3 -ErrorAction SilentlyContinue |
            Where-Object { $badExeNames -notcontains $_.Name.ToLower() } |
            Sort-Object { [int]($_.Name.ToLower() -replace '[^a-z0-9]','' -eq $safeName) } -Descending |
            Select-Object -First 1
          if ($candidates) { $exe = $candidates.FullName }
        }
        # Last resort: use whatever the icon path says, even if it's a bad exe
        if (-not $exe -and $iconPath -and $iconPath -match '(?i)^"?([A-Za-z]:[^",]+\.exe)') {
          $candidate = $Matches[1]
          if (Test-Path $candidate -ErrorAction SilentlyContinue) { $exe = $candidate }
        }
        return $exe
      }

      $regPaths = @(
        'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*',
        'HKLM:\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*',
        'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*'
      )
      foreach ($p in $regPaths) {
        try {
          Get-ItemProperty $p -ErrorAction SilentlyContinue |
            Where-Object { $_.DisplayName -and $_.DisplayName -notmatch '^ms-resource:' } |
            ForEach-Object {
              $exe = Find-BestExe $_.DisplayName $_.DisplayIcon $_.InstallLocation
              if ($exe -and (Test-Path $exe -ErrorAction SilentlyContinue)) {
                # Skip Store apps (WindowsApps folder) — AppX section handles them better
                if ($exe -match '\\WindowsApps\\') { return }
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

                # Resolve display name — prefer VisualElements name, fall back to Properties name,
                # skip entirely if still an unresolvable ms-resource: string
                $displayName = $xml.Package.Applications.Application.'uap:VisualElements'.DisplayName
                if (-not $displayName -or $displayName -match '^ms-resource:') {
                  $displayName = $xml.Package.Properties.DisplayName
                }
                if (-not $displayName -or $displayName -match '^ms-resource:') {
                  # Derive readable name from package name: "Microsoft.WindowsNotepad" -> "Windows Notepad"
                  $displayName = ($_.Name -replace '^[^.]+\.', '') -replace '([a-z])([A-Z])', '$1 $2'
                }

                $exeName = $xml.Package.Applications.Application.Executable
                if ($displayName -and $exeName) {
                  $fullExe = Join-Path $_.InstallLocation $exeName
                  if (Test-Path $fullExe -ErrorAction SilentlyContinue) {
                    $key = $fullExe.ToLower()
                    if (-not $apps.ContainsKey($key)) {
                      # Find the best icon PNG from the package Assets folder
                      $iconPath = ''
                      $logoRel = $xml.Package.Applications.Application.'uap:VisualElements'.Square44x44Logo
                      if (-not $logoRel) { $logoRel = $xml.Package.Properties.Logo }
                      if ($logoRel) {
                        $logoFull = Join-Path $_.InstallLocation $logoRel
                        if (Test-Path $logoFull) {
                          $iconPath = $logoFull
                        } else {
                          # Windows may store scaled versions like Logo.scale-100.png
                          $logoDir  = Join-Path $_.InstallLocation ([System.IO.Path]::GetDirectoryName($logoRel))
                          $logoBase = [System.IO.Path]::GetFileNameWithoutExtension($logoRel)
                          $found = Get-ChildItem -Path $logoDir -Filter "$logoBase*.png" -ErrorAction SilentlyContinue |
                            Sort-Object { [int]($_.Name -replace '[^0-9]','') } -Descending |
                            Select-Object -First 1
                          if ($found) { $iconPath = $found.FullName }
                        }
                      }
                      $apps[$key] = @{ name = $displayName; exe = $fullExe; iconPath = $iconPath }
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

    execFile('powershell', ['-NoProfile', '-OutputEncoding', 'UTF8', '-Command', psScript], {
      windowsHide: true,
      maxBuffer: 10 * 1024 * 1024,
      timeout: 30000,
      encoding: 'utf8'
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
            unique.push({ name: a.name, exe: a.exe, exeName: path.basename(a.exe), iconPath: a.iconPath || '' });
          }
        }
        unique.sort((a, b) => a.name.localeCompare(b.name));
        resolve(unique);
      } catch { resolve([]); }
    });
  });
}

async function getAppIcon(exePath, iconPath) {
  try {
    if (iconPath && fs.existsSync(iconPath)) {
      const { nativeImage } = require('electron');
      const img = nativeImage.createFromPath(iconPath);
      if (!img.isEmpty()) return img.toDataURL();
    }
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
      const icon = await getAppIcon(a.exe, a.iconPath);
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

// ── Single Instance Lock ───────────────────────────────────────────────────────
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    // Someone tried to run a second instance — focus our window instead
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });
}

// ── App Lifecycle ──────────────────────────────────────────────────────────────
app.on('before-quit', () => {
  app.isQuitting = true;
  if (pollInterval) clearInterval(pollInterval);
  if (sessionWatcher) { sessionWatcher.close(); sessionWatcher = null; }
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

  // Watch session file for instant hook-based integration response
  watchSessionFile();

  if (manualAwake) evaluateState();
});

app.on('window-all-closed', () => {
  // Don't quit — we live in the tray
});
