'use strict';
/**
 * Electron main process: window, menus, dialogs, and the bridge between the UI and the batch runner.
 *
 * The renderer never touches the file system. It asks for folders/files through IPC; this process
 * scans them, remembers the list, and only ever compresses files that came from its own scan.
 */
const path = require('path');
const fs = require('fs');
const {
  app, BrowserWindow, Menu, Notification, dialog, ipcMain, powerSaveBlocker, shell, nativeTheme,
} = require('electron');

const { Transcoder } = require('../core/transcoder');
const { BatchRunner, summarize } = require('../core/batch');
const { scanPaths, formatBytes } = require('../core/files');
const { sanitizeSettings } = require('../core/settings');

const IS_MAC = process.platform === 'darwin';
const TRASH_NAME = process.platform === 'win32' ? 'Recycle Bin' : 'Trash';
const REPO_URL = 'https://github.com/tdeletto/MP3-Bulk-Compressor-Desktop';

app.setName('MP3 Bulk Compressor Desktop');

/** Engine binary: inside the app's Resources folder when packaged, resources/engine/… in a checkout. */
function enginePath() {
  const exe = process.platform === 'win32' ? 'mp3bulk-engine.exe' : 'mp3bulk-engine';
  return app.isPackaged
    ? path.join(process.resourcesPath, 'engine', exe)
    : path.join(__dirname, '..', '..', 'resources', 'engine', `${process.platform}-${process.arch}`, exe);
}

const transcoder = new Transcoder({
  enginePath: enginePath(),
  tempDir: app.getPath('temp'),
  trashItem: (p) => shell.trashItem(p),
  trashName: TRASH_NAME,
});
const runner = new BatchRunner(transcoder, { trashName: TRASH_NAME });

/** @type {BrowserWindow|null} */
let win = null;
/** Files from the most recent scan; the only files a batch may touch. */
let currentFiles = [];
/** Paths passed in before the window was ready (Finder "Open With", drag onto the Dock/exe icon). */
let pendingOpenPaths = [];
let blockerId = null;

// ---------- Batch state → UI ----------

let sendTimer = null;
/** Coalesces rapid progress updates into at most ~12 UI updates per second. */
function pushState() {
  if (sendTimer) return;
  sendTimer = setTimeout(() => {
    sendTimer = null;
    const st = runner.state;
    if (!win || win.isDestroyed()) return;
    win.webContents.send('batch:state', st);
    if (st && !st.finished) win.setProgressBar(Math.min(1, summarize(st).fraction));
  }, 80);
}

runner.on('state', pushState);
runner.on('finished', (st) => {
  if (blockerId !== null) {
    powerSaveBlocker.stop(blockerId);
    blockerId = null;
  }
  if (win && !win.isDestroyed()) win.setProgressBar(-1);
  const s = summarize(st);
  if (Notification.isSupported() && win && !win.isFocused()) {
    new Notification({
      title: st.cancelled ? 'Compression stopped' : 'Compression finished',
      body: `${s.compressed} compressed, ${s.skipped} skipped, ${s.failed} failed · ${formatBytes(s.bytesSaved)} saved`,
    }).show();
  }
  if (IS_MAC && !st.cancelled) app.dock?.bounce('informational');
});

// ---------- IPC ----------

function registerIpc() {
  ipcMain.handle('app:info', () => ({
    version: app.getVersion(),
    platform: process.platform,
    trashName: TRASH_NAME,
    workers: runner.workers,
    fileManager: IS_MAC ? 'Finder' : 'File Explorer',
  }));

  ipcMain.handle('dialog:pickFolder', async () => {
    const r = await dialog.showOpenDialog(win, { title: 'Select a folder of MP3s', properties: ['openDirectory', 'multiSelections'] });
    return r.canceled ? [] : r.filePaths;
  });

  ipcMain.handle('dialog:pickFiles', async () => {
    const r = await dialog.showOpenDialog(win, {
      title: 'Select MP3 files',
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: 'MP3 audio', extensions: ['mp3'] }],
    });
    return r.canceled ? [] : r.filePaths;
  });

  ipcMain.handle('files:scan', async (_e, paths, recursive) => {
    if (runner.isRunning) throw new Error('A batch is running');
    const list = Array.isArray(paths) ? paths.filter((p) => typeof p === 'string') : [];
    currentFiles = await scanPaths(list, recursive === true);
    return currentFiles;
  });

  ipcMain.handle('files:clear', () => {
    if (!runner.isRunning) currentFiles = [];
  });

  ipcMain.handle('batch:start', (_e, settings, replace) => {
    if (runner.isRunning || currentFiles.length === 0) return false;
    blockerId = powerSaveBlocker.start('prevent-app-suspension'); // keep going with the display asleep
    runner.start(currentFiles, sanitizeSettings(settings), replace === true);
    pushState();
    return true;
  });

  ipcMain.handle('batch:cancel', () => runner.cancel());

  ipcMain.handle('batch:dismiss', () => {
    if (!runner.isRunning) runner.state = null;
  });

  ipcMain.handle('batch:state', () => runner.state);

  // Only paths the app itself produced or scanned can be revealed.
  ipcMain.handle('shell:reveal', (_e, p) => {
    const known = currentFiles.some((f) => f.path === p) ||
      runner.state?.results.some((r) => r.file.path === p || r.outcome.outputPath === p);
    if (known && fs.existsSync(p)) shell.showItemInFolder(p);
  });
}

// ---------- Window & menu ----------

function createWindow() {
  win = new BrowserWindow({
    width: 1120,
    height: 860,
    minWidth: 760,
    minHeight: 600,
    show: false,
    title: 'MP3 Bulk Compressor Desktop',
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#131318' : '#F8F6FC',
    titleBarStyle: IS_MAC ? 'hiddenInset' : 'default',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  });

  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  win.once('ready-to-show', () => win.show());

  // The UI is local-only: never navigate away or open new windows.
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e) => e.preventDefault());

  win.webContents.on('did-finish-load', () => {
    if (pendingOpenPaths.length) {
      win.webContents.send('app:openPaths', pendingOpenPaths);
      pendingOpenPaths = [];
    }
  });

  win.on('close', (e) => {
    if (!runner.isRunning) return;
    const choice = dialog.showMessageBoxSync(win, {
      type: 'warning',
      buttons: ['Keep Running', 'Stop and Quit'],
      defaultId: 0,
      cancelId: 0,
      message: 'A batch is still running.',
      detail: 'Stopping now leaves every original untouched. Files already finished stay finished.',
    });
    if (choice === 0) e.preventDefault();
    else runner.cancel();
  });
  win.on('closed', () => { win = null; });
}

function sendToUi(channel, ...args) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, ...args);
}

function buildMenu() {
  const template = [
    ...(IS_MAC ? [{ role: 'appMenu' }] : []),
    {
      label: 'File',
      submenu: [
        { label: 'Select Folder…', accelerator: 'CmdOrCtrl+O', click: () => sendToUi('menu:pickFolder') },
        { label: 'Select Files…', accelerator: 'CmdOrCtrl+Shift+O', click: () => sendToUi('menu:pickFiles') },
        { type: 'separator' },
        IS_MAC ? { role: 'close' } : { role: 'quit' },
      ],
    },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [{ role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { type: 'separator' }, { role: 'togglefullscreen' }],
    },
    { role: 'windowMenu' },
    {
      role: 'help',
      submenu: [
        { label: 'Project on GitHub', click: () => shell.openExternal(REPO_URL) },
        { label: 'Third-party Licenses', click: () => shell.openPath(path.join(app.isPackaged ? process.resourcesPath : path.join(__dirname, '..', '..', 'engine', 'third_party'), app.isPackaged ? 'licenses' : '')) },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

/**
 * MP3 paths from a command line (Windows "Open with", or dragging files onto the .exe).
 * Only for the packaged app: when run from source, argv holds the project folder and tooling
 * flags in unpredictable order, and opening the project folder would scan its test fixtures.
 */
function pathsFromArgv(argv) {
  if (!app.isPackaged) return [];
  return argv.slice(1).filter((a) => !a.startsWith('-') && fs.existsSync(a));
}

function openPaths(paths) {
  if (!paths.length) return;
  if (win && !win.webContents.isLoading()) sendToUi('app:openPaths', paths);
  else pendingOpenPaths.push(...paths);
  if (win) {
    if (win.isMinimized()) win.restore();
    win.focus();
  }
}

// ---------- Lifecycle ----------

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', (_e, argv) => openPaths(pathsFromArgv(argv)));

  // macOS: files dropped on the Dock icon or chosen via Finder's "Open With" (may fire before ready).
  app.on('open-file', (e, p) => {
    e.preventDefault();
    openPaths([p]);
  });

  app.whenReady().then(() => {
    registerIpc();
    buildMenu();
    pendingOpenPaths.push(...pathsFromArgv(process.argv));
    createWindow();
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    if (!IS_MAC || runner.isRunning === false) app.quit();
  });
}
