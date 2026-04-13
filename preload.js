const { contextBridge, ipcRenderer } = require('electron');

/**
 * Expose a safe, typed API to the renderer via window.api
 */
contextBridge.exposeInMainWorld('api', {
  // Window controls
  window: {
    minimize: () => ipcRenderer.invoke('window:minimize'),
    maximize: () => ipcRenderer.invoke('window:maximize'),
    close: () => ipcRenderer.invoke('window:close'),
  },

  // File system
  dialog: {
    openFile: (options) => ipcRenderer.invoke('dialog:openFile', options),
  },
  file: {
    read: (filePath) => ipcRenderer.invoke('file:read', filePath),
  },

  // AI
  ai: {
    query: (params) => ipcRenderer.invoke('ai:query', params),
  },

  // Web search
  web: {
    search: (params) => ipcRenderer.invoke('web:search', params),
  },

  // Persistent storage
  storage: {
    get: (key) => ipcRenderer.invoke('storage:get', key),
    set: (key, value) => ipcRenderer.invoke('storage:set', { key, value }),
    delete: (key) => ipcRenderer.invoke('storage:delete', key),
    getAll: (prefix) => ipcRenderer.invoke('storage:getAll', prefix),
  },

  // Shell
  shell: {
    openExternal: (url) => ipcRenderer.invoke('shell:openExternal', url),
  },
});
