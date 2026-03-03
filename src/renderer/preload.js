const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  // Send messages to main process
  send: (channel, data) => {
    const validChannels = ['request-init', 'stream-action', 'get-template-placeholders', 'update-settings', 'save-output-config', 'get-audio-devices', 'get-whisper-status', 'set-whisper-model', 'download-whisper-model', 'delete-whisper-model', 'cancel-whisper-download', 'whisper-model-selected'];
    if (validChannels.includes(channel)) {
      ipcRenderer.send(channel, data);
    }
  },
  // Receive messages from main process
  on: (channel, callback) => {
    const validChannels = ['init-data', 'stream-update', 'preview-frame', 'templates-updated', 'template-placeholders', 'rtmp-stats', 'settings-saved', 'audio-devices', 'whisper-status', 'whisper-model-needed', 'function-result'];
    if (validChannels.includes(channel)) {
      ipcRenderer.on(channel, (_event, ...args) => callback(...args));
    }
  },
});
