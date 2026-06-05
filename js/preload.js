const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('bumpforgeElectron', {
  isElectron: true,

  saveFile: (options) =>
    ipcRenderer.invoke('save-file', options),

  openFile: (options) =>
    ipcRenderer.invoke('open-file', options),

  chooseDirectory: () =>
    ipcRenderer.invoke('choose-directory')
});