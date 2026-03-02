const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  // Send messages to main process
  send: (channel, data) => {
    const validChannels = ['request-init', 'stream-action', 'get-template-placeholders', 'update-settings'];
    if (validChannels.includes(channel)) {
      ipcRenderer.send(channel, data);
    }
  },
  // Receive messages from main process
  on: (channel, callback) => {
    const validChannels = ['init-data', 'stream-update', 'preview-frame', 'templates-updated', 'template-placeholders', 'rtmp-stats', 'settings-saved'];
    if (validChannels.includes(channel)) {
      ipcRenderer.on(channel, (_event, ...args) => callback(...args));
    }
  },
});
