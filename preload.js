const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('insomnia', {
  getStatus: () => ipcRenderer.invoke('get-status'),
  toggleAwake: () => ipcRenderer.invoke('toggle-awake'),
  addApp: (appData) => ipcRenderer.invoke('add-app', appData),
  removeApp: (exe) => ipcRenderer.invoke('remove-app', exe),
  toggleApp: (exe) => ipcRenderer.invoke('toggle-app', exe),
  getInstalledApps: () => ipcRenderer.invoke('get-installed-apps'),
  browseExe: () => ipcRenderer.invoke('browse-exe'),
  onStatusUpdate: (callback) => {
    ipcRenderer.on('status-update', (_, status) => callback(status));
  }
});
