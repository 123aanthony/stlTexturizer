const { app, BrowserWindow } = require('electron');
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
    '.wasm': 'application/wasm'
  }[ext] || 'application/octet-stream';
}

function startLocalServer(rootDir) {
  const server = http.createServer((req, res) => {
    const urlPath = decodeURIComponent(req.url.split('?')[0]);
    const safePath = urlPath === '/' ? '/index.html' : urlPath;
    const filePath = path.join(rootDir, safePath);

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

async function createWindow() {
  const rootDir = __dirname;
  localServer = await startLocalServer(rootDir);

  const win = new BrowserWindow({
    width: 1600,
    height: 1000,
    autoHideMenuBar: true,
    title: 'BumpForge',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  await win.loadURL(`http://127.0.0.1:${PORT}/index.html`);
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  if (localServer) localServer.close();
  if (process.platform !== 'darwin') app.quit();
});