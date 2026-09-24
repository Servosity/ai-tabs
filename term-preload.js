const { contextBridge, ipcRenderer, webUtils } = require('electron');

// Terminal views load remote/server HTML and need almost no privileges — the
// only bridge they get is resolving a dropped File to its absolute path, so
// drag-and-drop from Explorer can insert the path into the prompt.
contextBridge.exposeInMainWorld('electronTerm', {
  getPathForFile: (file) => {
    try {
      return webUtils.getPathForFile(file);
    } catch {
      return '';
    }
  },
});

// The OS clipboard is a property of THIS machine, and Electron's clipboard
// module reaches it from any origin — unlike navigator.clipboard, which
// Chromium hides on the insecure http://<lan-ip> origins terminal views load.
contextBridge.exposeInMainWorld('electronClipboard', {
  read: () => ipcRenderer.invoke('clipboard-read'),
  write: (text) => ipcRenderer.invoke('clipboard-write', text),
});

// Media panel → tab-bar badge. The terminal page counts images that arrived
// while its panel was collapsed; main stamps the count on the tab so the bar
// can draw a dot, the same way page-title-updated drives idle/flashing.
contextBridge.exposeInMainWorld('electronMedia', {
  badge: (count) => ipcRenderer.send('media-badge', Number(count) || 0),
});

// Remote-server config is a property of THIS machine, not the machine serving
// the page — so it goes over IPC to the local main process, never over /api.
contextBridge.exposeInMainWorld('electronRemote', {
  getConfig: () => ipcRenderer.invoke('remote-config-get'),
  restart: () => ipcRenderer.invoke('app-restart'),
  pickerList: () => ipcRenderer.invoke('picker-list'),
  pickerLaunch: (id) => ipcRenderer.invoke('picker-launch', id),
  pickerAdd: (entry) => ipcRenderer.invoke('picker-add', entry),
  pickerRemove: (id) => ipcRenderer.invoke('picker-remove', id),
  pickerOpen: () => ipcRenderer.invoke('picker-open'),
});
