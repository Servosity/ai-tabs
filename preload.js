const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  createTab: (urlOrOpts) => ipcRenderer.send('tab-create', urlOrOpts),
  switchTab: (id) => ipcRenderer.send('tab-switch', id),
  closeTab: (id) => ipcRenderer.send('tab-close', id),
  muteTab: (id) => ipcRenderer.send('tab-mute', id),
  pinTab: (id) => ipcRenderer.send('tab-pin', id),
  renameTab: (id, title) => ipcRenderer.send('tab-rename', id, title),
  moveTab: (fromIndex, toIndex) => ipcRenderer.send('tab-move', fromIndex, toIndex),
  detachTab: (tabId, screenX, screenY) => ipcRenderer.send('tab-detach', tabId, screenX, screenY),
  hideForDrag: () => ipcRenderer.send('hide-for-drag'),
  showAfterDrag: () => ipcRenderer.send('show-after-drag'),
  onTabsUpdated: (callback) => {
    ipcRenderer.on('tabs-updated', (e, tabs) => callback(tabs));
  },
  onTabActivated: (callback) => {
    ipcRenderer.on('tab-activated', () => callback());
  },
  expandTabBar: () => ipcRenderer.invoke('tab-bar-expand'),
  collapseTabBar: () => ipcRenderer.send('tab-bar-collapse'),
  showDragGhost: (title, screenX, screenY) => ipcRenderer.send('drag-ghost-show', title, screenX, screenY),
  moveDragGhost: (screenX, screenY) => ipcRenderer.send('drag-ghost-move', screenX, screenY),
  hideDragGhost: () => ipcRenderer.send('drag-ghost-hide'),
  dragForeignMove: (screenX, screenY) => ipcRenderer.send('drag-foreign-move', screenX, screenY),
  dragForeignEnd: () => ipcRenderer.send('drag-foreign-end'),
  foreignDragIndex: (index) => ipcRenderer.send('foreign-drag-index', index),
  onForeignDragOver: (cb) => ipcRenderer.on('foreign-drag-over', (e, clientX) => cb(clientX)),
  onForeignDragLeave: (cb) => ipcRenderer.on('foreign-drag-leave', () => cb()),
  getTabs: () => ipcRenderer.invoke('get-tabs'),
  getTheme: () => ipcRenderer.invoke('get-theme'),
  onSettingsUpdated: (cb) => ipcRenderer.on('settings-updated', () => cb()),
  claimControl: () => ipcRenderer.send('claim-control'),
});
