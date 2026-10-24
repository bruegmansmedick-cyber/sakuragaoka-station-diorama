const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('sakuraWidget', {
  minimize: () => ipcRenderer.send('widget:minimize'),
  hide: () => ipcRenderer.send('widget:hide'),
  showMenu: () => ipcRenderer.send('widget:show-menu')
});

ipcRenderer.on('widget:reset-view', () => {
  window.dispatchEvent(new CustomEvent('sakura:diorama-reset'));
});

ipcRenderer.on('widget:lock-changed', (_event, locked) => {
  document.body.classList.toggle('widget-locked', Boolean(locked));
});
