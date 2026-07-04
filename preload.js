const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('bumpforgeElectron', {
  isElectron: true,

  saveBlob: (options) =>
    ipcRenderer.invoke('save-blob', options),

  saveFile: (options) =>
    ipcRenderer.invoke('save-file', options),

  openFile: (options) =>
    ipcRenderer.invoke('open-file', options),

  readFile: (options) =>
    ipcRenderer.invoke('read-file-by-path', options),

  writeFile: (options) =>
    ipcRenderer.invoke('write-file-by-path', options),

  chooseDirectory: () =>
    ipcRenderer.invoke('choose-directory'),

  saveSetting: (key, value) =>
    ipcRenderer.invoke('save-setting', key, value),

  loadSetting: (key) =>
    ipcRenderer.invoke('load-setting', key),

  scanTextureLibrary: (folderPath) =>
    ipcRenderer.invoke('scan-texture-library', folderPath),

  setWindowTitle: (title) =>
    ipcRenderer.invoke('set-window-title', title),

  // Real filesystem path of a dropped/picked File (File.path was removed from
  // Electron). Lets the renderer find sidecar files next to a loaded model.
  getFilePath: (file) => {
    try { return webUtils.getPathForFile(file) || null; } catch { return null; }
  },

  // ── Save-before-quit (unsaved-changes guard on window close) ──
  // Renderer keeps the main process informed of dirty state + localized prompt
  // labels; main shows a native 3-way dialog on close and asks us to save.
  setDirty: (dirty) => ipcRenderer.send('set-dirty', !!dirty),
  setClosePrompt: (labels) => ipcRenderer.send('set-close-prompt', labels),
  onSaveRequest: (cb) => ipcRenderer.on('app-save-request', () => cb()),
  saveDone: (ok) => ipcRenderer.send('app-save-done', !!ok)
});
