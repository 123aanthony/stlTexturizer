const { contextBridge, ipcRenderer } = require('electron');

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
    ipcRenderer.invoke('scan-texture-library', folderPath)
});
