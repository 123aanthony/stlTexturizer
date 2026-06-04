const { app, BrowserWindow, dialog, ipcMain } = require('electron');
const path = require('path');
const http = require('http');
const fs = require('fs');

const PORT = 3927;

function getMimeType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return {
    '.html': 'text/html',
    '.js': 'application/javascript',
    '.css': 'text/css',
    '.json': 'application/json',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    '.svg': 'image/svg+xml',
    '.stl': 'model/stl',
    '.3mf': 'model/3mf',
    '.stltprofile': 'application/json',
    '.bumpmesh': 'application/octet-stream',
    '.wasm': 'application/wasm'
  }[ext] || 'application/octet-stream';
}

function getSaveFilters(filename) {
  const ext = path.extname(filename || '').toLowerCase().replace('.', '');
  if (!ext) return [{ name: 'All files', extensions: ['*'] }];

  const names = {
    stl: 'STL model',
    '3mf': '3MF model',
    bumpmesh: 'BumpForge project',
    stltprofile: 'Material profile',
    json: 'JSON file',
    png: 'PNG image',
    jpg: 'JPEG image',
    jpeg: 'JPEG image',
    webp: 'WebP image'
  };

  return [
    { name: names[ext] || `${ext.toUpperCase()} file`, extensions: [ext] },
    { name: 'All files', extensions: ['*'] }
  ];
}

function startLocalServer(rootDir) {
  const server = http.createServer((req, res) => {
    const urlPath = decodeURIComponent(req.url.split('?')[0]);
    const safePath = urlPath === '/' ? '/index.html' : urlPath;
    const filePath = path.normalize(path.join(rootDir, safePath));

    if (!filePath.startsWith(rootDir)) {
      res.writeHead(403);
      res.end('Forbidden');
      return;
    }

    fs.readFile(filePath, (err, data) => {
      if (err) {
        res.writeHead(404);
        res.end('Not found');
        return;
      }

      res.writeHead(200, {
        'Content-Type': getMimeType(filePath),
        'Cache-Control': 'no-store'
      });
      res.end(data);
    });
  });

  return new Promise((resolve) => {
    server.listen(PORT, '127.0.0.1', () => resolve(server));
  });
}

let localServer = null;

const SETTINGS_FILE = path.join(app.getPath('userData'), 'bumpforge-settings.json');
const TEXTURE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp']);

function readSettings() {
  try {
    return JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
  } catch {
    return {};
  }
}

function writeSettings(data) {
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(data, null, 2));
}

function fileToDataUrl(filePath) {
  const data = fs.readFileSync(filePath);
  const mime = getMimeType(filePath);
  return `data:${mime};base64,${data.toString('base64')}`;
}

function scanTextureLibraryFolder(rootDir) {
  if (!rootDir || !fs.existsSync(rootDir)) return [];

  return fs.readdirSync(rootDir, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(dir => {
      const folderPath = path.join(rootDir, dir.name);
      const files = fs.readdirSync(folderPath, { withFileTypes: true })
        .filter(file => file.isFile())
        .filter(file => TEXTURE_EXTS.has(path.extname(file.name).toLowerCase()))
        .map(file => {
          const filePath = path.join(folderPath, file.name);
          const stat = fs.statSync(filePath);
          return {
            name: file.name,
            path: filePath,
            size: stat.size,
            mtimeMs: stat.mtimeMs,
            key: `electron:${filePath}:${stat.size}:${Math.round(stat.mtimeMs)}`,
            dataUrl: fileToDataUrl(filePath)
          };
        });

      return {
        name: dir.name,
        path: folderPath,
        files
      };
    })
    .filter(group => group.files.length > 0);
}


async function createWindow() {
  const rootDir = __dirname;
  localServer = await startLocalServer(rootDir);

  const win = new BrowserWindow({
    width: 1600,
    height: 1000,
    autoHideMenuBar: true,
    title: 'BumpForge',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      devTools: true
    }
  });

  // Keep DevTools auto-open while stabilising Electron. Remove later for packaging.
  win.webContents.openDevTools();

  await win.loadURL(`http://127.0.0.1:${PORT}/index.html`);
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  if (localServer) localServer.close();
  if (process.platform !== 'darwin') app.quit();
});

ipcMain.handle('save-blob', async (_, options = {}) => {
  const filename = options.filename || 'download.bin';

  const result = await dialog.showSaveDialog({
    title: options.title || 'Save File',
    defaultPath: filename,
    filters: options.filters || getSaveFilters(filename)
  });

  if (result.canceled || !result.filePath) {
    return { canceled: true };
  }

  try {
    const bytes = options.data ? Buffer.from(new Uint8Array(options.data)) : Buffer.alloc(0);
    await fs.promises.writeFile(result.filePath, bytes);
    return { canceled: false, filePath: result.filePath };
  } catch (err) {
    return { canceled: false, error: err.message };
  }
});

ipcMain.handle('save-file', async (_, options = {}) => {
  return dialog.showSaveDialog({
    title: options.title || 'Save File',
    defaultPath: options.defaultPath || '',
    filters: options.filters || []
  });
});

ipcMain.handle('open-file', async (_, options = {}) => {
  return dialog.showOpenDialog({
    properties: ['openFile'],
    filters: options.filters || []
  });
});

ipcMain.handle('choose-directory', async () => {
  return dialog.showOpenDialog({
    properties: ['openDirectory']
  });
});


ipcMain.handle('save-setting', (_, key, value) => {
  const settings = readSettings();
  settings[key] = value;
  writeSettings(settings);
  return true;
});

ipcMain.handle('load-setting', (_, key) => {
  const settings = readSettings();
  return settings[key] ?? null;
});

ipcMain.handle('scan-texture-library', (_, folderPath) => {
  return scanTextureLibraryFolder(folderPath);
});
