// main.js
const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');

const isDev = !app.isPackaged;
const DATA_FILE = path.join(app.getPath('userData'), 'outstanding_items.json');

function ensureDataFile() {
  if (!fs.existsSync(DATA_FILE)) {
    fs.writeFileSync(DATA_FILE, '[]', 'utf-8');
  }
}

function readItems() {
  ensureDataFile();
  try {
    const raw = fs.readFileSync(DATA_FILE, 'utf-8');
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

function writeItems(items) {
  ensureDataFile();
  fs.writeFileSync(DATA_FILE, JSON.stringify(items ?? [], null, 2), 'utf-8');
}

let win;

const CONFIG_FILE = path.join(app.getPath('userData'), 'config.json');
let dataFileOverride = null;
let watcher = null;

function readConfig() {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'));
    }
  } catch {}
  return {};
}

function writeConfig(cfg) {
  try {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2), 'utf-8');
  } catch (e) {
    console.error('[config write error]', e);
  }
}

function getDataFile() {
  return dataFileOverride || DATA_FILE;
}

function startWatching(win) {
  const file = getDataFile();
  try {
    if (watcher) watcher.close();
  } catch {}
  ensureDataFileAt(file);
  watcher = fs.watch(file, { persistent: false }, () => {
    try {
      const arr = readItemsAt(file);
      win?.webContents.send('items:updated', arr);
    } catch (e) {
      console.error('[watch read error]', e);
    }
  });
}

function ensureDataFileAt(filePath) {
  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, '[]', 'utf-8');
  }
}

function readItemsAt(filePath) {
  ensureDataFileAt(filePath);
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

function writeItemsAt(filePath, items) {
  ensureDataFileAt(filePath);
  fs.writeFileSync(filePath, JSON.stringify(items ?? [], null, 2), 'utf-8');
}

// keep your originals but make them use the helpers
function ensureDataFile() { ensureDataFileAt(getDataFile()); }
function readItems()      { return readItemsAt(getDataFile()); }
function writeItems(items){ return writeItemsAt(getDataFile(), items); }






async function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 900,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  if (isDev) {
    await win.loadURL('http://localhost:5173/');
    win.webContents.openDevTools({ mode: 'detach' });
  } else {
    await win.loadFile(path.join(__dirname, 'renderer', 'dist', 'index.html'));
  }



  // Load persisted dataFile override if present
  const cfg = readConfig();
  if (cfg.dataFile && typeof cfg.dataFile === 'string') {
    dataFileOverride = cfg.dataFile;
  }
  console.log('[data file]', getDataFile());

  // start watcher for live updates
  startWatching(win);



  // Optional: watch for external edits and notify the renderer
  // console.log("not sure if I need this line below")
  // ensureDataFile();
  // fs.watch(DATA_FILE, { persistent: false }, () => {
  //   if (win && !win.isDestroyed()) {
  //     const arr = readItems();
  //     win.webContents.send('items:updated', arr);
  //   }
  // });

  


}

app.whenReady().then(createWindow);
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });


const { shell } = require('electron');

// Report the current path
ipcMain.handle('items:get-path', () => {
  return { path: getDataFile() };
});

// Reveal in Finder
ipcMain.handle('items:reveal', () => {
  const file = getDataFile();
  if (fs.existsSync(file)) shell.showItemInFolder(file);
  return { ok: true };
});

// Choose a new JSON file
ipcMain.handle('items:choose-file', async () => {
  const res = await dialog.showOpenDialog({
    title: 'Choose items JSON',
    properties: ['openFile'],
    filters: [{ name: 'JSON', extensions: ['json'] }]
  });
  if (res.canceled || !res.filePaths?.[0]) return { ok: false, canceled: true };

  dataFileOverride = res.filePaths[0];

  // persist selection
  const cfg = readConfig();
  cfg.dataFile = dataFileOverride;
  writeConfig(cfg);

  // restart watcher and push fresh data
  startWatching(win);
  const arr = readItems();
  win?.webContents.send('items:updated', arr);
  return { ok: true, path: dataFileOverride };
});

ipcMain.handle('items:use-default', () => {
  dataFileOverride = null;
  const cfg = readConfig();
  delete cfg.dataFile;
  writeConfig(cfg);
  startWatching(win);
  const arr = readItems();
  win?.webContents.send('items:updated', arr);
  return { ok: true, path: getDataFile() };
});


// IPC: read
ipcMain.handle('items:read', () => {
  return readItems();
});

// IPC: write
ipcMain.handle('items:write', (_evt, items) => {
  writeItems(items);
  return { ok: true };
});

// IPC: export via Save Dialog
ipcMain.handle('items:export', async (_evt, items) => {
  const { canceled, filePath } = await dialog.showSaveDialog({
    title: 'Export updated items',
    defaultPath: 'outstanding_items.updated.json',
    filters: [{ name: 'JSON', extensions: ['json'] }]
  });
  if (canceled || !filePath) return { ok: false, canceled: true };
  fs.writeFileSync(filePath, JSON.stringify(items ?? [], null, 2), 'utf-8');
  return { ok: true, filePath };
});
