const {
  app,
  BrowserWindow,
  globalShortcut,
  ipcMain,
  Menu,
  nativeImage,
  screen,
  shell,
  Tray
} = require('electron');
const fs = require('fs');
const path = require('path');

const APP_ID = 'com.sakuragaoka.diorama.widget';
const PROJECT_URL = 'https://bruegmansmedick-cyber.github.io/sakuragaoka-station-diorama/';
const MIN_SIZE = 340;
const MAX_SIZE = 1200;
const SIZE_PRESETS = [
  { label: '迷你桌角挂件 (380 × 380)', width: 380, height: 380 },
  { label: '标准桌面摆件 (560 × 560)', width: 560, height: 560 },
  { label: '高清收藏展台 (780 × 780)', width: 780, height: 780 },
  { label: '大屏观赏模式 (1024 × 768)', width: 1024, height: 768 }
];

let mainWindow = null;
let tray = null;
let isQuitting = false;
let isWindowLocked = false;
let saveBoundsTimer = null;

app.commandLine.appendSwitch('enable-gpu-rasterization');
app.commandLine.appendSwitch('enable-zero-copy');

app.setAppUserModelId(APP_ID);

const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) {
  app.quit();
}

function getStateFile() {
  return path.join(app.getPath('userData'), 'window-state.json');
}

function readSavedBounds() {
  try {
    const value = JSON.parse(fs.readFileSync(getStateFile(), 'utf8'));
    const bounds = {
      x: Number(value.x),
      y: Number(value.y),
      width: Number(value.width),
      height: Number(value.height)
    };

    if (!Object.values(bounds).every(Number.isFinite)) {
      return null;
    }

    const intersectsDisplay = screen.getAllDisplays().some(({ workArea }) => {
      const overlapWidth = Math.min(bounds.x + bounds.width, workArea.x + workArea.width)
        - Math.max(bounds.x, workArea.x);
      const overlapHeight = Math.min(bounds.y + bounds.height, workArea.y + workArea.height)
        - Math.max(bounds.y, workArea.y);
      return overlapWidth >= 120 && overlapHeight >= 120;
    });

    return intersectsDisplay ? bounds : null;
  } catch {
    return null;
  }
}

function getInitialBounds() {
  const saved = readSavedBounds();
  if (saved) {
    return {
      ...saved,
      width: Math.min(MAX_SIZE, Math.max(MIN_SIZE, saved.width)),
      height: Math.min(MAX_SIZE, Math.max(MIN_SIZE, saved.height))
    };
  }

  const { workArea } = screen.getPrimaryDisplay();
  const size = 560;
  const margin = 28;
  return {
    width: size,
    height: size,
    x: Math.max(workArea.x, workArea.x + workArea.width - size - margin),
    y: Math.max(workArea.y, workArea.y + workArea.height - size - margin)
  };
}

function scheduleBoundsSave() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }

  clearTimeout(saveBoundsTimer);
  saveBoundsTimer = setTimeout(() => {
    try {
      fs.writeFileSync(getStateFile(), JSON.stringify(mainWindow.getBounds(), null, 2));
    } catch (error) {
      console.warn('Unable to save window bounds:', error.message);
    }
  }, 250);
}

function clampWindowIntoDisplay() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }

  const bounds = mainWindow.getBounds();
  const { workArea } = screen.getDisplayMatching(bounds);
  const width = Math.min(workArea.width, Math.max(MIN_SIZE, bounds.width));
  const height = Math.min(workArea.height, Math.max(MIN_SIZE, bounds.height));
  const x = Math.min(workArea.x + workArea.width - width, Math.max(workArea.x, bounds.x));
  const y = Math.min(workArea.y + workArea.height - height, Math.max(workArea.y, bounds.y));
  if (x !== bounds.x || y !== bounds.y || width !== bounds.width || height !== bounds.height) {
    mainWindow.setBounds({ x, y, width, height }, true);
  }
}

function showWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createMainWindow();
    return;
  }
  mainWindow.show();
  mainWindow.focus();
}

function hideWindow() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.hide();
  }
}

function toggleWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createMainWindow();
    return;
  }
  if (mainWindow.isVisible()) {
    mainWindow.hide();
  } else {
    showWindow();
  }
}

function setWindowLocked(locked) {
  isWindowLocked = Boolean(locked);
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.setMovable(!isWindowLocked);
    mainWindow.webContents.send('widget:lock-changed', isWindowLocked);
  }
  refreshTrayMenu();
}

function resizeWidget(width, height) {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }

  const boundedWidth = Math.min(MAX_SIZE, Math.max(MIN_SIZE, width));
  const boundedHeight = Math.min(MAX_SIZE, Math.max(MIN_SIZE, height));
  mainWindow.setSize(boundedWidth, boundedHeight, true);
  clampWindowIntoDisplay();
  scheduleBoundsSave();
}

function resetView() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('widget:reset-view');
    showWindow();
  }
}

function setSceneAtmosphere(kind, value) {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }
  const safeValue = String(value).replace(/[^a-zA-Z]/g, '');
  const method = kind === 'weather' ? 'setWeather' : 'setTime';
  mainWindow.webContents.executeJavaScript(
    `window.sakuraAtmosphere && window.sakuraAtmosphere.${method}('${safeValue}');`
  ).catch((error) => {
    console.warn('Unable to update scene atmosphere:', error.message);
  });
}

function buildApplicationMenu() {
  const alwaysOnTop = Boolean(mainWindow && !mainWindow.isDestroyed()
    && mainWindow.isAlwaysOnTop());

  return Menu.buildFromTemplate([
    {
      label: mainWindow && mainWindow.isVisible() ? '隐藏桌景' : '显示桌景',
      click: toggleWindow
    },
    { type: 'separator' },
    {
      label: '始终置顶',
      type: 'checkbox',
      checked: alwaysOnTop,
      click: (menuItem) => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.setAlwaysOnTop(menuItem.checked, 'floating');
          refreshTrayMenu();
        }
      }
    },
    {
      label: '锁定窗口位置',
      type: 'checkbox',
      checked: isWindowLocked,
      click: (menuItem) => setWindowLocked(menuItem.checked)
    },
    { type: 'separator' },
    {
      label: '桌景尺寸',
      submenu: SIZE_PRESETS.map((preset) => ({
        label: preset.label,
        click: () => resizeWidget(preset.width, preset.height)
      }))
    },
    {
      label: '场景时段',
      submenu: [
        { label: '白昼', click: () => setSceneAtmosphere('time', 'day') },
        { label: '夕阳', click: () => setSceneAtmosphere('time', 'sunset') },
        { label: '蓝调时刻', click: () => setSceneAtmosphere('time', 'blueHour') },
        { label: '傍晚', click: () => setSceneAtmosphere('time', 'dusk') }
      ]
    },
    {
      label: '天气',
      submenu: [
        { label: '晴天', click: () => setSceneAtmosphere('weather', 'clear') },
        { label: '下雨', click: () => setSceneAtmosphere('weather', 'rain') },
        { label: '下雪', click: () => setSceneAtmosphere('weather', 'snow') }
      ]
    },
    {
      label: '重置 3D 视角',
      accelerator: 'CommandOrControl+Shift+R',
      click: resetView
    },
    {
      label: '打开在线作品页',
      click: () => shell.openExternal(PROJECT_URL)
    },
    { type: 'separator' },
    {
      label: '退出桌景',
      accelerator: 'CommandOrControl+Shift+Q',
      click: () => {
        isQuitting = true;
        app.quit();
      }
    }
  ]);
}

function refreshTrayMenu() {
  if (tray && !tray.isDestroyed()) {
    tray.setContextMenu(buildApplicationMenu());
  }
}

function createTray() {
  const iconPath = path.join(__dirname, 'assets', 'tray-icon.png');
  let icon = nativeImage.createFromPath(iconPath);

  if (icon.isEmpty()) {
    icon = nativeImage.createEmpty();
  } else {
    icon = icon.resize({ width: 16, height: 16 });
  }

  tray = new Tray(icon);
  tray.setToolTip('桜ヶ丘駅 · 3D 微缩桌景');
  refreshTrayMenu();

  tray.on('click', toggleWindow);
  tray.on('double-click', showWindow);
}

async function injectDesktopWidgetOverlay(win) {
  const css = `
    html, body {
      border-radius: 18px;
      overflow: hidden;
    }
    body {
      box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.62);
    }
    #sakura-widget-bar {
      position: fixed;
      inset: 0 0 auto 0;
      z-index: 2147483647;
      height: 30px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 0 10px;
      color: #213547;
      font: 600 11px/1.2 "Yu Gothic UI", "Microsoft YaHei", sans-serif;
      letter-spacing: 0.02em;
      background: linear-gradient(
        180deg,
        rgba(255, 255, 255, 0.92) 0%,
        rgba(255, 245, 249, 0.76) 64%,
        rgba(255, 255, 255, 0) 100%
      );
      opacity: 0;
      transition: opacity 160ms ease;
      -webkit-app-region: drag;
      user-select: none;
    }
    #sakura-widget-bar:hover,
    #sakura-widget-bar:focus-within {
      opacity: 1;
    }
    body.widget-locked #sakura-widget-bar {
      display: none;
    }
    #sakura-widget-bar .sakura-widget-label {
      display: inline-flex;
      gap: 6px;
      align-items: center;
      padding: 3px 9px;
      border-radius: 999px;
      background: rgba(255, 255, 255, 0.82);
      box-shadow: 0 2px 8px rgba(73, 94, 115, 0.12);
    }
    #sakura-widget-bar .sakura-widget-actions {
      display: flex;
      gap: 6px;
      -webkit-app-region: no-drag;
    }
    #sakura-widget-bar button {
      width: 22px;
      height: 22px;
      padding: 0;
      border: 0;
      border-radius: 50%;
      display: grid;
      place-items: center;
      color: #31485d;
      background: rgba(255, 255, 255, 0.84);
      box-shadow: 0 2px 7px rgba(73, 94, 115, 0.16);
      font: 700 13px/1 sans-serif;
      cursor: pointer;
      transition: transform 140ms ease, background 140ms ease, color 140ms ease;
    }
    #sakura-widget-bar button:hover {
      transform: translateY(-1px) scale(1.06);
      background: #fff;
    }
    #sakura-widget-bar button[data-action="hide"]:hover {
      color: #fff;
      background: #ff6c88;
    }
  `;

  const javascript = `
    (() => {
      if (document.getElementById('sakura-widget-bar') || !window.sakuraWidget) {
        return;
      }

      const bar = document.createElement('div');
      bar.id = 'sakura-widget-bar';
      bar.innerHTML = \`
        <span class="sakura-widget-label">🌸 桜ヶ丘駅 · 按住顶部拖动</span>
        <span class="sakura-widget-actions">
          <button type="button" data-action="minimize" title="最小化">–</button>
          <button type="button" data-action="hide" title="隐藏到系统托盘">×</button>
        </span>
      \`;
      document.body.appendChild(bar);

      bar.querySelector('[data-action="minimize"]').addEventListener('click', () => {
        window.sakuraWidget.minimize();
      });
      bar.querySelector('[data-action="hide"]').addEventListener('click', () => {
        window.sakuraWidget.hide();
      });
      bar.addEventListener('contextmenu', (event) => {
        event.preventDefault();
        window.sakuraWidget.showMenu();
      });
    })();
  `;

  if (win.isDestroyed()) {
    return;
  }
  await win.webContents.insertCSS(css);
  await win.webContents.executeJavaScript(javascript);
  win.webContents.send('widget:lock-changed', isWindowLocked);
}

function createMainWindow() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    showWindow();
    return;
  }

  mainWindow = new BrowserWindow({
    ...getInitialBounds(),
    minWidth: MIN_SIZE,
    minHeight: MIN_SIZE,
    maxWidth: MAX_SIZE,
    maxHeight: MAX_SIZE,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: true,
    roundedCorners: true,
    resizable: true,
    minimizable: true,
    maximizable: false,
    fullscreenable: false,
    alwaysOnTop: true,
    skipTaskbar: false,
    show: false,
    title: '桜ヶ丘駅 · 日式樱花车站微缩桌景',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      backgroundThrottling: false,
      devTools: !app.isPackaged
    }
  });

  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-navigate', (event) => event.preventDefault());
  mainWindow.webContents.on('will-attach-webview', (event) => event.preventDefault());

  mainWindow.once('ready-to-show', () => {
    if (!mainWindow || mainWindow.isDestroyed()) {
      return;
    }
    mainWindow.show();
    mainWindow.focus();
  });

  mainWindow.webContents.on('did-finish-load', () => {
    injectDesktopWidgetOverlay(mainWindow).catch((error) => {
      console.warn('Unable to inject desktop widget controls:', error.message);
    });
  });

  mainWindow.on('move', scheduleBoundsSave);
  mainWindow.on('resize', () => {
    clampWindowIntoDisplay();
    scheduleBoundsSave();
  });
  mainWindow.on('show', refreshTrayMenu);
  mainWindow.on('hide', refreshTrayMenu);
  mainWindow.on('close', (event) => {
    if (!isQuitting) {
      event.preventDefault();
      mainWindow.hide();
    }
  });
  mainWindow.on('closed', () => {
    mainWindow = null;
    refreshTrayMenu();
  });

  mainWindow.loadFile(path.join(__dirname, 'index.html'));
}

function registerShortcuts() {
  const shortcuts = [
    ['CommandOrControl+Shift+S', toggleWindow],
    ['CommandOrControl+Shift+T', () => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.setAlwaysOnTop(!mainWindow.isAlwaysOnTop(), 'floating');
        refreshTrayMenu();
      }
    }],
    ['CommandOrControl+Shift+R', resetView],
    ['CommandOrControl+Shift+Q', () => {
      isQuitting = true;
      app.quit();
    }]
  ];

  for (const [accelerator, callback] of shortcuts) {
    if (!globalShortcut.register(accelerator, callback)) {
      console.warn(`Global shortcut is already in use: ${accelerator}`);
    }
  }
}

ipcMain.on('widget:minimize', () => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.minimize();
  }
});

ipcMain.on('widget:hide', hideWindow);

ipcMain.on('widget:show-menu', () => {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }
  buildApplicationMenu().popup({ window: mainWindow });
});

app.whenReady().then(() => {
  createMainWindow();
  createTray();
  registerShortcuts();

  app.on('activate', showWindow);
});

app.on('second-instance', showWindow);

app.on('before-quit', () => {
  isQuitting = true;
  clearTimeout(saveBoundsTimer);
  if (mainWindow && !mainWindow.isDestroyed()) {
    try {
      fs.writeFileSync(getStateFile(), JSON.stringify(mainWindow.getBounds(), null, 2));
    } catch {
      // The window can still close if state persistence is unavailable.
    }
  }
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin' && isQuitting) {
    app.quit();
  }
});
