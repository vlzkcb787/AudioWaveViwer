// ===================================
// preload.js
// - 렌더러에서 필요한 최소 브릿지 제공
// - 현재 예제는 DOM/웹 API로 충분해서 빈 래퍼
// ===================================
const { contextBridge } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  // 필요한 경우 IPC 정의 가능
});
