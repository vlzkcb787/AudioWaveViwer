// ===================================
// main.js
// - Electron 메인 프로세스
// - 윈도우 생성, 미디어 권한 처리
// ===================================
const { app, BrowserWindow, session } = require('electron');
const path = require('path');

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 860,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      // getUserMedia 사용을 위해 아래 옵션은 기본값으로 충분
      // nodeIntegration: false, contextIsolation: true (preload.js 사용)
    }
  });

  win.loadFile(path.join(__dirname, 'renderer.html'));
}

app.whenReady().then(async () => {
  // 마이크 권한 허용(필요 시)
  const ses = session.defaultSession;
  ses.setPermissionRequestHandler((_wc, permission, callback) => {
    if (permission === 'media') {
      return callback(true);
    }
    callback(false);
  });

  createWindow();

  app.on('activate', function () {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', function () {
  if (process.platform !== 'darwin') app.quit();
});
