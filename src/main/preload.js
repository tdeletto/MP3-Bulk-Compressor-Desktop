'use strict';
/**
 * Preload: the only API the (sandboxed) UI gets. Every call goes through IPC to the main process.
 */
const { contextBridge, ipcRenderer, webUtils } = require('electron');

/** Subscribes to a main-process event; returns an unsubscribe function. */
function on(channel, callback) {
  const listener = (_event, ...args) => callback(...args);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld('api', {
  /** { version, platform, trashName, workers, fileManager } */
  info: () => ipcRenderer.invoke('app:info'),
  pickFolder: () => ipcRenderer.invoke('dialog:pickFolder'),
  pickFiles: () => ipcRenderer.invoke('dialog:pickFiles'),
  /** Scans files/folders; resolves with the MP3 list the main process will compress. */
  scan: (paths, recursive) => ipcRenderer.invoke('files:scan', paths, recursive),
  clear: () => ipcRenderer.invoke('files:clear'),
  start: (settings, replace) => ipcRenderer.invoke('batch:start', settings, replace),
  cancel: () => ipcRenderer.invoke('batch:cancel'),
  dismiss: () => ipcRenderer.invoke('batch:dismiss'),
  state: () => ipcRenderer.invoke('batch:state'),
  reveal: (path) => ipcRenderer.invoke('shell:reveal', path),
  /** Real path of a File from a drag-and-drop event. */
  pathForFile: (file) => webUtils.getPathForFile(file),
  onState: (cb) => on('batch:state', cb),
  onOpenPaths: (cb) => on('app:openPaths', cb),
  onMenu: (cb) => {
    const offFolder = on('menu:pickFolder', () => cb('pickFolder'));
    const offFiles = on('menu:pickFiles', () => cb('pickFiles'));
    return () => { offFolder(); offFiles(); };
  },
});
