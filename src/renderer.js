// ===================================
// renderer.js
// - Web Audio API로 입력 캡처
// - Waveform/Spectrum 실시간 그리기
// - 모드: Realtime / Peak-Hold
// - 스펙트럼 드래그 선택: 해당 대역만 실시간 재생(없으면 전체)
// - 출력 On/Off 토글
// ===================================

// 기능 설명 주석:
// - 디바이스 선택: enumerateDevices → audioinput 목록 바인딩
// - Start: getUserMedia({audio:{deviceId}}) → AudioContext → 소스
// - 청취 경로: source → (선택 시) HPF → LPF → gainOut → destination
// - 분석 경로: source → analyser (FFT), source → timeAnalyser (time-domain)
// - 스펙트럼 피크홀드: peakBins[] 저장, 프레임마다 decay 적용
// - 드래그 선택: specCanvas에서 mousedown/move/up으로 [x1,x2] 저장 → 주파수 환산

const inputSelect = document.getElementById('inputSelect');
const btnStart = document.getElementById('btnStart');
const btnStopRealtime = document.getElementById('btnStopRealtime');
const btnOutput = document.getElementById('btnOutput');
const btnClear = document.getElementById('btnClear');
const statusEl = document.getElementById('status');

const specCanvas = document.getElementById('specCanvas');
const sctx = specCanvas.getContext('2d');

// 볼륨 관련 요소들
const volumeGauge = document.getElementById('volumeGauge');
const volumeValue = document.getElementById('volumeValue');
const volumeDisplay = document.getElementById('volumeDisplay');
const gaugeCtx = volumeGauge.getContext('2d');

// v4.0: 새로운 상단바 UI 요소
const btnModeRealtime = document.getElementById('btnModeRealtime');
const btnModeFile = document.getElementById('btnModeFile');
const realtimeControls = document.getElementById('realtimeControls');
const fileControls = document.getElementById('fileControls');
const fileInput = document.getElementById('fileInput');
const fileName = document.getElementById('fileName');
const btnPlay = document.getElementById('btnPlay');
const btnPause = document.getElementById('btnPause');
const btnStop = document.getElementById('btnStop');
const btnRepeat = document.getElementById('btnRepeat');
const timelineGauge = document.getElementById('timelineGauge');
const timelineGaugeCtx = timelineGauge ? timelineGauge.getContext('2d') : null;
const currentTime = document.getElementById('currentTime');
const totalTime = document.getElementById('totalTime');
const loadingModal = document.getElementById('loadingModal');

// 캔버스 크기 동적 설정
function resizeCanvas() {
  const wrapper = specCanvas.parentElement;
  const rect = wrapper.getBoundingClientRect();
  
  // 패딩을 고정값으로 설정
  const padding = { left: 40, right: 10, top: 10, bottom: 40 };
  
  // 실제 캔버스 크기 계산
  const canvasWidth = rect.width - padding.left - padding.right;
  const canvasHeight = rect.height - padding.top - padding.bottom;
  
  // 캔버스 크기 설정
  specCanvas.width = canvasWidth;
  specCanvas.height = canvasHeight;
  
  // CSS 크기는 래퍼에 맞춤
  specCanvas.style.width = rect.width + 'px';
  specCanvas.style.height = rect.height + 'px';
}

let audioCtx = null;
let mediaStream = null;
let sourceNode = null;

let analyser = null;
let timeAnalyser = null;
let visualAnalyser = null; // 시각화 전용 AnalyserNode (오디오 출력과 분리)

// v4.0: 통합 오디오 소스 관리
let currentSourceNode = null; // 현재 활성 소스 (마이크 또는 파일)
let inputMode = 'none'; // 'realtime', 'file', 'none'
let realtimeSourceNode = null; // 실시간 입력 소스
let fileSourceNode = null; // 파일 재생 소스
let isPlaying = false;
let isRepeating = false;
let fileDuration = 0;
let fileBuffer = null;
let isRealtimeActive = false; // 실시간 모드 활성 상태

let gainOut = null;
let highpass = null;
let lowpass = null;

let outputEnabled = false;
let peakBins = null;
let lastFrameTime = 0; // v4.0: 0으로 초기화하여 drawLoop 시작 조건 활성화

// 볼륨 제어
let volumeLevel = 1.0; // 0.0 ~ 10.0 (0% ~ 1000%)

// 스펙트럼 드래그 선택 상태
let dragging = false;
let dragStartX = null;
let dragEndX = null;
let selectedBandHz = null; // {lo, hi}
let selectedBandPixels = null; // {x1, x2} - 원시 픽셀 좌표

// Analyser 설정
const FFT_SIZE = 2048; // 1024/2048/4096 등
const SMOOTHING_TIME_CONSTANT = 0.0; // 실시간 반응

// 초기화: 입력 디바이스 나열
async function populateInputDevices() {
  const devices = await navigator.mediaDevices.enumerateDevices();
  inputSelect.innerHTML = '';
  devices
    .filter(d => d.kind === 'audioinput')
    .forEach((d, i) => {
      const opt = document.createElement('option');
      opt.value = d.deviceId;
      opt.textContent = `${d.label || 'Audio Input ' + (i+1)}`;
      inputSelect.appendChild(opt);
    });
}

// v4.0: 실시간 오디오 입력 시작 (통합 구조)
async function startAudio() {
  try {
    // 현재 입력 중지
    stopCurrentInput();

    const deviceId = inputSelect.value || undefined;

    mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        deviceId: deviceId ? { exact: deviceId } : undefined,
        channelCount: 2,
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        sampleRate: 48000
      }
    });

    // 오디오 컨텍스트 초기화 (필요시)
    if (!audioCtx) {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)({ 
        latencyHint: 'interactive',
        sampleRate: 48000
      });
      
      if (audioCtx.baseLatency) {
        console.log(`v4.0: Audio context base latency: ${audioCtx.baseLatency * 1000}ms`);
      }
    }

    // 공통 오디오 노드 초기화 (필요시)
    initializeAudioNodes();

    // 실시간 소스 생성
    realtimeSourceNode = audioCtx.createMediaStreamSource(mediaStream);
    
    // 통합 입력 모드로 전환
    currentSourceNode = realtimeSourceNode;
    inputMode = 'realtime';
    connectAudioPipeline();
    
    // UI 상태 업데이트
    switchToRealtimeInput();

    // UI 상태
    isRealtimeActive = true;
    btnStart.disabled = true;
    btnStopRealtime.disabled = false;
    statusEl.textContent = `v4.0 Unified Real-time Audio @ ${audioCtx.sampleRate} Hz`;

    // 시각화 시작
    if (!lastFrameTime) {
      lastFrameTime = performance.now();
      console.log('v4.0: Starting drawLoop from startAudio (realtime mode)');
      requestAnimationFrame(drawLoop);
    } else {
      console.log('v4.0: drawLoop already running from startAudio (realtime mode)');
    }

  } catch (err) {
    statusEl.textContent = `Start error: ${err}`;
    console.error(err);
    stopCurrentInput();
  }
}

// v4.0: 공통 오디오 노드 초기화
function initializeAudioNodes() {
  if (!gainOut) {
    gainOut = audioCtx.createGain();
    gainOut.gain.value = outputEnabled ? volumeLevel : 0.0;
  }

  if (!highpass) {
    highpass = audioCtx.createBiquadFilter();
    highpass.type = 'highpass';
    highpass.frequency.value = 20;
    highpass.Q.value = 0.707;
  }

  if (!lowpass) {
    lowpass = audioCtx.createBiquadFilter();
    lowpass.type = 'lowpass';
    lowpass.frequency.value = 20000;
    lowpass.Q.value = 0.707;
  }

  if (!visualAnalyser) {
    visualAnalyser = audioCtx.createAnalyser();
    visualAnalyser.fftSize = FFT_SIZE;
    visualAnalyser.smoothingTimeConstant = SMOOTHING_TIME_CONSTANT;
    console.log('v4.0: visualAnalyser created with FFT size:', FFT_SIZE);
  }

  // 하위 호환성을 위한 analyser
  if (!analyser) {
    analyser = visualAnalyser;
  }
}

// v4.0: 통합 오디오 파이프라인 (실시간/파일 모드 공통)
function connectAudioPipeline() {
  if (!currentSourceNode || !gainOut || !visualAnalyser) return;

  // 기존 연결 해제
  try {
    if (highpass) highpass.disconnect();
    if (lowpass) lowpass.disconnect();
    if (gainOut) gainOut.disconnect();
    if (visualAnalyser) visualAnalyser.disconnect();
    if (currentSourceNode) currentSourceNode.disconnect();
  } catch (e) {}

  // v4.0: 통합 실시간 오디오 파이프라인 (AnalyserNode 제거)
  // 출력 경로: 선택 대역이 있으면 HPF→LPF 경유, 없으면 바로
  if (selectedBandHz) {
    highpass.frequency.value = Math.max(10, selectedBandHz.lo);
    lowpass.frequency.value = Math.max(highpass.frequency.value + 10, selectedBandHz.hi);
    currentSourceNode.connect(highpass);
    highpass.connect(lowpass);
    lowpass.connect(gainOut);
  } else {
    currentSourceNode.connect(gainOut);
  }

  // 볼륨 적용
  gainOut.gain.value = outputEnabled ? volumeLevel : 0.0;
  console.log(`connectAudioPipeline: Volume applied - gain: ${gainOut.gain.value} (mode: ${inputMode})`);
  gainOut.connect(audioCtx.destination);

  // v4.0: 시각화는 별도 파이프라인 (오디오 출력에 영향 없음)
  currentSourceNode.connect(visualAnalyser);
  console.log(`v4.0: Unified audio pipeline connected (mode: ${inputMode})`);
  console.log(`v4.0: visualAnalyser connected, FFT size: ${visualAnalyser.fftSize}`);
}

// 하위 호환성을 위한 래퍼 함수
function connectGraph() {
  connectAudioPipeline();
}

// v4.0: UI 모드 전환 함수들 (새로운 상단바 구조)
function switchToRealtimeMode() {
  // v4.0: 파일 재생이 진행 중이라면 먼저 정지
  if (isPlaying && inputMode === 'file') {
    console.log('v4.0: Stopping file playback before switching to realtime mode');
    if (fileSourceNode) {
      try {
        fileSourceNode.disconnect();
        fileSourceNode.stop();
      } catch (e) {
        console.warn('v4.0: Error stopping fileSourceNode in mode switch:', e);
      }
      fileSourceNode = null;
    }
    isPlaying = false;
    stopTimeUpdate();
  }
  
  // UI 모드 전환
  btnModeRealtime.classList.add('active');
  btnModeFile.classList.remove('active');
  realtimeControls.style.display = 'flex';
  fileControls.style.display = 'none';
  
  // 입력 모드 상태
  if (inputMode !== 'realtime') {
    stopCurrentInput();
    inputMode = 'realtime';
    currentSourceNode = realtimeSourceNode;
  }
  
  // v4.0: 볼륨 동기화 - 실시간 모드로 전환 시 현재 볼륨 적용
  if (gainOut) {
    gainOut.gain.value = outputEnabled ? volumeLevel : 0.0;
    console.log(`v4.0: Volume synchronized to realtime mode: ${gainOut.gain.value} (${volumeLevel * 100}%)`);
  }
  
  console.log('v4.0: Switched to realtime mode (UI)');
}

function switchToFileMode() {
  // v4.0: 실시간 모드가 Start 상태라면 먼저 Stop
  if (isRealtimeActive && inputMode === 'realtime') {
    console.log('v4.0: Stopping realtime audio before switching to file mode');
    stopAudio();
  }
  
  // UI 모드 전환
  btnModeFile.classList.add('active');
  btnModeRealtime.classList.remove('active');
  realtimeControls.style.display = 'none';
  fileControls.style.display = 'flex';
  
  // 파일이 로드되지 않은 경우 버튼 비활성화
  if (!fileBuffer) {
    btnPlay.disabled = true;
    btnPause.disabled = true;
    btnStop.disabled = true;
    fileName.textContent = '파일을 선택하세요';
  } else {
    // 파일이 로드된 경우
    if (inputMode !== 'file') {
      stopCurrentInput();
      inputMode = 'file';
      currentSourceNode = fileSourceNode;
    }
    btnPlay.disabled = false;
    btnPause.disabled = true;
    btnStop.disabled = true;
    
    // v4.0: 볼륨 동기화 - 파일 모드로 전환 시 현재 볼륨 적용
    if (gainOut) {
      gainOut.gain.value = outputEnabled ? volumeLevel : 0.0;
      console.log(`v4.0: Volume synchronized to file mode: ${gainOut.gain.value} (${volumeLevel * 100}%)`);
    }
  }
  
  console.log('v4.0: Switched to file mode (UI)');
}

// 하위 호환성을 위한 래퍼 함수들
function switchToRealtimeInput() {
  switchToRealtimeMode();
}

function switchToFileInput() {
  switchToFileMode();
}

// v4.0: 로딩 모달 제어 함수
function showLoadingModal() {
  loadingModal.style.display = 'flex';
  console.log('v4.0: Loading modal shown');
}

function hideLoadingModal() {
  loadingModal.style.display = 'none';
  console.log('v4.0: Loading modal hidden');
}

// v4.0: 현재 활성 오디오 소스에 볼륨 즉시 적용
function updateCurrentVolume() {
  if (gainOut && currentSourceNode) {
    gainOut.gain.value = outputEnabled ? volumeLevel : 0.0;
    console.log(`v4.0: Volume updated to current source: ${gainOut.gain.value} (${volumeLevel * 100}%)`);
  }
}

// v4.0: 타임라인 게이지 상태 관리
let currentTimelineProgress = 0; // 현재 진행률 저장

// v4.0: 타임라인 게이지 그리기 함수
function drawTimelineGauge(progressPercent) {
  if (!timelineGaugeCtx) return;
  
  // 현재 진행률 저장
  currentTimelineProgress = progressPercent;
  
  const canvas = timelineGauge;
  const ctx = timelineGaugeCtx;
  const width = canvas.width;
  const height = canvas.height;
  
  // 캔버스 클리어
  ctx.clearRect(0, 0, width, height);
  
  // 회색 백그라운드
  ctx.fillStyle = '#e0e0e0';
  ctx.fillRect(0, 0, width, height);
  
  // 초록색 fill 영역 (진행률에 따라)
  const fillWidth = (progressPercent / 100) * width;
  ctx.fillStyle = '#4caf50';
  ctx.fillRect(0, 0, fillWidth, height);
  
  // 경계선 (둥근 모서리 - 호환성)
  ctx.strokeStyle = '#ccc';
  ctx.lineWidth = 1;
  ctx.beginPath();
  if (ctx.roundRect) {
    ctx.roundRect(0.5, 0.5, width - 1, height - 1, 10);
  } else {
    // 호환성을 위한 직사각형
    ctx.rect(0.5, 0.5, width - 1, height - 1);
  }
  ctx.stroke();
}

// v4.0: 현재 타임라인 진행률 반환
function getCurrentTimelineProgress() {
  return currentTimelineProgress;
}

function stopCurrentInput() {
  if (inputMode === 'realtime' && realtimeSourceNode) {
    // 실시간 입력 중지
    if (mediaStream) {
      mediaStream.getTracks().forEach(t => t.stop());
    }
    realtimeSourceNode = null;
  } else if (inputMode === 'file' && fileSourceNode) {
    // 파일 재생 중지
    if (fileSourceNode) {
      fileSourceNode.disconnect();
      fileSourceNode.stop();
      fileSourceNode = null;
    }
    isPlaying = false;
  }
  
  currentSourceNode = null;
  inputMode = 'none';
  
  console.log('v4.0: Stopped current input');
}

// v4.0: 실시간 오디오 중지 (통합 구조)
function stopAudio() {
  if (inputMode === 'realtime') {
    stopCurrentInput();
  }
  
  // UI 업데이트
  isRealtimeActive = false;
  btnStart.disabled = false;
  btnStopRealtime.disabled = true;
  statusEl.textContent = 'Stopped';
  
  console.log('v4.0: Real-time audio stopped via unified structure');
}

// 스펙트럼 그리기
function drawLoop(t) {
  // v4.0: 통합 구조에서 시각화 (visualAnalyser만 사용)
  if (!audioCtx) {
    console.warn('v4.0: audioCtx not available in drawLoop');
    return;
  }
  if (!visualAnalyser) {
    console.warn('v4.0: visualAnalyser not available in drawLoop');
    return;
  }

  const dt = (t - lastFrameTime) / 1000.0;
  lastFrameTime = t;

  // 디버깅: 매 60프레임마다 상태 출력
  if (Math.floor(t / 1000) !== Math.floor((t - dt * 1000) / 1000)) {
    console.log(`v4.0: drawLoop running - mode: ${inputMode}, currentSourceNode: ${!!currentSourceNode}, visualAnalyser: ${!!visualAnalyser}`);
  }

  drawSpectrum(dt);

  requestAnimationFrame(drawLoop);
}



function drawSpectrum(dt) {
  // 캔버스 크기와 실제 크기 일치 확인
  const rect = specCanvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  const width = rect.width * dpr;
  const height = rect.height * dpr;
  
  // 캔버스 크기가 다르면 조정
  if (specCanvas.width !== width || specCanvas.height !== height) {
    specCanvas.width = width;
    specCanvas.height = height;
    specCanvas.style.width = rect.width + 'px';
    specCanvas.style.height = rect.height + 'px';
    sctx.scale(dpr, dpr);
  }

  // 그리드와 축을 그리고 플롯 영역 정보를 받아옴 (실제 크기 사용)
  const plotArea = drawSpecGridAndAxes(sctx, rect.width, rect.height);

  // v4.0: 시각화 전용 AnalyserNode 사용 (오디오 출력과 분리)
  if (!visualAnalyser) {
    // 분석기가 없으면 빈 스펙트럼만 그리기
    console.warn('v4.0: visualAnalyser not available, drawing empty spectrum');
    return;
  }
  
  const n = visualAnalyser.frequencyBinCount;
  const freqData = new Float32Array(n);
  visualAnalyser.getFloatFrequencyData(freqData);
  
  // v4.0: 파일 모드에서 오디오 데이터 확인
  if (inputMode === 'file' && isPlaying) {
    const dataSum = freqData.reduce((sum, val) => sum + Math.abs(val), 0);
    if (dataSum === 0) {
      console.warn('v4.0: No audio data from visualAnalyser in file mode');
    }
  }

  if (!peakBins || peakBins.length !== n) {
    peakBins = new Float32Array(n);
    for (let i = 0; i < n; i++) peakBins[i] = -120.0;
  }

  // Peak-Hold 데이터 업데이트 - 최대치가 내려오지 않고 새로운 최대값만 갱신
  for (let i = 0; i < n; i++) {
    const cur = freqData[i];
    if (!peakBins || peakBins[i] === undefined) {
      peakBins = new Float32Array(n);
      for (let j = 0; j < n; j++) peakBins[j] = -120.0;
    }
    // 새로운 최대값만 갱신 (감쇠 없음)
    peakBins[i] = Math.max(cur, peakBins[i]);
  }
  
  // Realtime 라인 그리기 (스플라인 곡선)
  const realtimePoints = [];
  for (let i = 0; i < n; i++) {
    const db = freqData[i];
    const x = plotArea.plotX + hzToCanvasXFromBin(i, n, plotArea.plotWidth);
    const y = plotArea.plotY + dbToY(db, plotArea.plotHeight);
    realtimePoints.push({ x, y });
  }
  drawSmoothCurve(sctx, realtimePoints, '#64b5f6', 1.2);
  
  // Peak-Hold 라인 그리기 (스플라인 곡선)
  const peakPoints = [];
  for (let i = 0; i < n; i++) {
    const db = peakBins[i];
    const x = plotArea.plotX + hzToCanvasXFromBin(i, n, plotArea.plotWidth);
    const y = plotArea.plotY + dbToY(db, plotArea.plotHeight);
    peakPoints.push({ x, y });
  }
  drawSmoothCurve(sctx, peakPoints, '#e57373', 1.5);

  // 드래그/선택 영역 렌더링
  if (dragStartX !== null && dragEndX !== null) {
    // 파란색 드래그 영역은 원시 픽셀 좌표를 직접 사용 (정확한 마우스 위치)
    const x1 = Math.min(dragStartX, dragEndX);
    const x2 = Math.max(dragStartX, dragEndX);
    
    // 플롯 영역 내에서만 렌더링
    if (x1 >= plotArea.plotX && x2 <= plotArea.plotX + plotArea.plotWidth) {
      sctx.fillStyle = 'rgba(100, 181, 246, 0.15)';
      sctx.fillRect(x1, plotArea.plotY, x2 - x1, plotArea.plotHeight);
      sctx.strokeStyle = '#90caf9';
      sctx.lineWidth = 1;
      sctx.strokeRect(x1 + 0.5, plotArea.plotY + 0.5, (x2 - x1) - 1, plotArea.plotHeight - 1);
    }
  }
  if (selectedBandHz && selectedBandPixels) {
    // 원시 픽셀 좌표를 직접 사용하여 파란색 영역과 정확히 일치
    const x1 = selectedBandPixels.x1;
    const x2 = selectedBandPixels.x2;
    
    sctx.fillStyle = 'rgba(76, 175, 80, 0.14)';
    sctx.fillRect(x1, plotArea.plotY, x2 - x1, plotArea.plotHeight);
    sctx.strokeStyle = '#66bb6a';
    sctx.strokeRect(x1 + 0.5, plotArea.plotY + 0.5, (x2 - x1) - 1, plotArea.plotHeight - 1);
    sctx.fillStyle = '#c8e6c9';
    sctx.font = '12px system-ui';
    sctx.textAlign = 'left';
    sctx.fillText(`${Math.round(selectedBandHz.lo)} Hz ~ ${Math.round(selectedBandHz.hi)} Hz`, x1 + 6, plotArea.plotY + 16);
  }
}


function dbToY(db, height) {
  const minDb = -120, maxDb = 0;
  const norm = (db - minDb) / (maxDb - minDb);
  const y = height - Math.max(0, Math.min(1, norm)) * height;
  return y;
}

// 스플라인 곡선 그리기 함수
function drawSmoothCurve(ctx, points, color, lineWidth) {
  if (points.length < 2) return;
  
  ctx.strokeStyle = color;
  ctx.lineWidth = lineWidth;
  ctx.beginPath();
  
  // 첫 번째 점으로 이동
  ctx.moveTo(points[0].x, points[0].y);
  
  // 스플라인 곡선 그리기 (Catmull-Rom 스플라인)
  for (let i = 0; i < points.length - 1; i++) {
    const p0 = i > 0 ? points[i - 1] : points[i];
    const p1 = points[i];
    const p2 = points[i + 1];
    const p3 = i < points.length - 2 ? points[i + 2] : points[i + 1];
    
    // Catmull-Rom 스플라인 제어점 계산
    const cp1x = p1.x + (p2.x - p0.x) / 6;
    const cp1y = p1.y + (p2.y - p0.y) / 6;
    const cp2x = p2.x - (p3.x - p1.x) / 6;
    const cp2y = p2.y - (p3.y - p1.y) / 6;
    
    ctx.bezierCurveTo(cp1x, cp1y, cp2x, cp2y, p2.x, p2.y);
  }
  
  ctx.stroke();
}

// ===================================
// v4.0.1: 통일된 주파수 변환 모듈
// ===================================

// 전역 주파수 설정 (모든 변환에서 동일하게 사용)
const FREQUENCY_CONFIG = {
  values: [0, 50, 100, 200, 300, 400, 500, 600, 700, 800, 900, 1000, 2000, 5000, 10000],
  maxFreq: 10000,
  minFreq: 0
};

// 로그 스케일 변환을 위한 캐시된 값들
const FREQUENCY_CACHE = {
  logFreqs: null,
  initialized: false
};

// 주파수 변환 모듈 초기화
function initFrequencyModule() {
  if (!FREQUENCY_CACHE.initialized) {
    FREQUENCY_CACHE.logFreqs = FREQUENCY_CONFIG.values.map(f => f === 0 ? 0 : Math.log10(f));
    FREQUENCY_CACHE.initialized = true;
  }
}

// 주파수 → X좌표 변환 (통일된 로직)
function hzToCanvasX(hz, width) {
  initFrequencyModule();
  
  const { values } = FREQUENCY_CONFIG;
  const { logFreqs } = FREQUENCY_CACHE;
  
  // 범위 체크
  if (hz <= values[0]) return 0;
  if (hz >= values[values.length - 1]) return width;
  
  // 로그 스케일 변환
  const logHz = hz === 0 ? 0 : Math.log10(hz);
  
  // 구간 찾기 및 보간
  for (let i = 0; i < logFreqs.length - 1; i++) {
    const f1 = logFreqs[i];
    const f2 = logFreqs[i + 1];
    
    if (logHz >= f1 && logHz <= f2) {
      const ratio = (logHz - f1) / (f2 - f1);
      const x1 = (i / (logFreqs.length - 1)) * width;
      const x2 = ((i + 1) / (logFreqs.length - 1)) * width;
      return x1 + ratio * (x2 - x1);
    }
  }
  
  return 0;
}

// X좌표 → 주파수 변환 (정확한 역변환)
function canvasXToHz(x, width) {
  initFrequencyModule();
  
  const { values } = FREQUENCY_CONFIG;
  const { logFreqs } = FREQUENCY_CACHE;
  
  // 범위 체크
  if (x <= 0) return values[0];
  if (x >= width) return values[values.length - 1];
  
  // 구간 찾기 및 역보간
  for (let i = 0; i < logFreqs.length - 1; i++) {
    const x1 = (i / (logFreqs.length - 1)) * width;
    const x2 = ((i + 1) / (logFreqs.length - 1)) * width;
    
    if (x >= x1 && x <= x2) {
      const ratio = (x - x1) / (x2 - x1);
      const logF1 = logFreqs[i];
      const logF2 = logFreqs[i + 1];
      const logHz = logF1 + ratio * (logF2 - logF1);
      
      return logHz === 0 ? 0 : Math.pow(10, logHz);
    }
  }
  
  return values[0];
}

// FFT 빈 인덱스 → X좌표 변환
function hzToCanvasXFromBin(binIndex, totalBins, width) {
  const ny = (audioCtx ? audioCtx.sampleRate : 48000) / 2;
  const freq = (binIndex / totalBins) * ny;
  return hzToCanvasX(freq, width);
}

// 그리드용 주파수 값들 반환 (필터링된)
function getGridFrequencyValues() {
  const ny = (audioCtx ? audioCtx.sampleRate : 48000) / 2;
  return FREQUENCY_CONFIG.values.filter(f => f <= ny);
}

// 이벤트: 출력 토글, 선택 해제
btnOutput.addEventListener('click', () => {
  outputEnabled = !outputEnabled;
  btnOutput.classList.toggle('on', outputEnabled);
  btnOutput.textContent = outputEnabled ? 'Output: ON' : 'Output: OFF';
  
  // v4.0: 현재 활성 오디오 소스에 즉시 적용
  updateCurrentVolume();
  console.log(`Output toggled: ${outputEnabled}, gain: ${gainOut ? gainOut.gain.value : 'N/A'}, volumeLevel: ${volumeLevel}`);
});

btnClear.addEventListener('click', () => {
  clearBand();
});

// 스펙트럼 마우스 이벤트
specCanvas.addEventListener('mousedown', (e) => {
  const rect = specCanvas.getBoundingClientRect();
  const mouseX = e.clientX - rect.left;
  
  // drawSpecGridAndAxes와 동일한 패딩 사용 (좌측 라벨 영역 제거)
  const padding = { top: 10, right: 10, bottom: 40, left: 0 };
  const plotX = padding.left;
  const plotWidth = rect.width - padding.left - padding.right;
  
  // 마우스가 플롯 영역 내에 있는지 확인
  if (mouseX >= plotX && mouseX <= plotX + plotWidth) {
    if (e.button === 0) { // 좌클릭 - 드래그 선택
      dragging = true;
      dragStartX = mouseX;
      dragEndX = mouseX;
    } else if (e.button === 2) { // 우클릭 - Max Peak 리셋
      e.preventDefault();
      resetMaxPeaks();
    }
  }
});

window.addEventListener('mousemove', (e) => {
  if (!dragging) return;
  const rect = specCanvas.getBoundingClientRect();
  const mouseX = e.clientX - rect.left;
  
  // drawSpecGridAndAxes와 동일한 패딩 사용 (좌측 라벨 영역 제거)
  const padding = { top: 10, right: 10, bottom: 40, left: 0 };
  const plotX = padding.left;
  const plotWidth = rect.width - padding.left - padding.right;
  
  dragEndX = Math.max(plotX, Math.min(plotX + plotWidth, mouseX));
});

window.addEventListener('mouseup', (e) => {
  if (!dragging) return;
  dragging = false;

  if (dragStartX !== null && dragEndX !== null) {
    const rect = specCanvas.getBoundingClientRect();
    // v4.0.1: 통일된 패딩 사용 (drawSpecGridAndAxes와 동일)
    const padding = { top: 10, right: 10, bottom: 40, left: 0 };
    const plotX = padding.left;
    const plotWidth = rect.width - padding.left - padding.right;
    
    // 초록색 영역과 동일한 방식으로 좌표 계산
    const x1 = Math.min(dragStartX, dragEndX);
    const x2 = Math.max(dragStartX, dragEndX);
    
    if (x1 >= plotX && x2 <= plotX + plotWidth && x2 - x1 >= 5) { // 최소 5픽셀 드래그
      // 주파수 변환 없이 원시 픽셀 좌표만 사용
      selectedBandPixels = { x1, x2 }; // 원시 픽셀 좌표 저장
      
      // v4.0.1: 정확한 주파수 계산 (통일된 변환 함수 사용)
      const plotX1 = x1 - plotX;
      const plotX2 = x2 - plotX;
      const lo = canvasXToHz(plotX1, plotWidth);
      const hi = canvasXToHz(plotX2, plotWidth);
      selectedBandHz = { lo, hi }; // 필터링용으로만 사용
      
      statusEl.textContent = `Band selected: ${Math.round(lo)} Hz ~ ${Math.round(hi)} Hz`;
      connectGraph(); // HPF/LPF 갱신
    } else {
      // 드래그가 아닌 단순 클릭 - Clear Band
      clearBand();
    }
  }
  dragStartX = dragEndX = null;
});

// 우클릭 컨텍스트 메뉴 방지
specCanvas.addEventListener('contextmenu', (e) => {
  e.preventDefault();
});

// Max Peak 리셋 함수
function resetMaxPeaks() {
  if (peakBins) {
    for (let i = 0; i < peakBins.length; i++) {
      peakBins[i] = -120.0;
    }
  }
  statusEl.textContent = 'Max peaks reset - new recording started';
}

// Clear Band 함수
function clearBand() {
  selectedBandHz = null;
  selectedBandPixels = null;
  dragStartX = dragEndX = null;
  connectGraph(); // 전체 통과로 복귀
  statusEl.textContent = 'Band selection cleared';
}

// 볼륨 게이지 그리기 함수
function drawVolumeGauge(volumePercent) {
  const canvas = volumeGauge;
  const ctx = gaugeCtx;
  const width = canvas.width;
  const height = canvas.height;
  
  // 캔버스 초기화
  ctx.clearRect(0, 0, width, height);
  
  // 배경 그리기 (회색)
  ctx.fillStyle = '#f5f5f5';
  ctx.fillRect(0, 0, width, height);
  
  // 볼륨에 따른 채움 높이 계산
  // 100% = 중간(1/2), 500% = 3/4, 1000% = 최대(4/4)
  let fillHeight;
  if (volumePercent <= 100) {
    // 0-100%: 0에서 중간까지
    fillHeight = (volumePercent / 100) * (height / 2);
  } else if (volumePercent <= 500) {
    // 100-500%: 중간에서 3/4까지
    const progress = (volumePercent - 100) / 400;
    fillHeight = (height / 2) + progress * (height / 4);
  } else {
    // 500-1000%: 3/4에서 최대까지
    const progress = (volumePercent - 500) / 500;
    fillHeight = (height * 3 / 4) + progress * (height / 4);
  }
  
  // 색상 보간 처리 구간 확인 및 색상 결정
  let gaugeColor;
  if (volumePercent >= 100 && volumePercent <= 120) {
    // 100-120%: 초록-노랑 색상 보간
    gaugeColor = interpolateColor('#4caf50', '#ffeb3b', volumePercent, 100, 120);
  } else if (volumePercent >= 121 && volumePercent <= 500) {
    // 121-500%: 노랑-주황 색상 보간
    gaugeColor = interpolateColor('#ffeb3b', '#ff9800', volumePercent, 121, 500);
  } else if (volumePercent >= 501 && volumePercent <= 520) {
    // 501-520%: 주황-빨강 색상 보간
    gaugeColor = interpolateColor('#ff9800', '#f44336', volumePercent, 501, 520);
  } else if (volumePercent >= 521 && volumePercent <= 1000) {
    // 521-1000%: 빨강-진홍 색상 보간
    gaugeColor = interpolateColor('#f44336', '#8b0000', volumePercent, 521, 1000);
  } else {
    // 일반 색상
    if (volumePercent <= 100) {
      gaugeColor = '#4caf50'; // 초록색 (0-100%)
    } else if (volumePercent <= 120) {
      gaugeColor = '#ffeb3b'; // 노란색 (120%)
    } else if (volumePercent <= 500) {
      gaugeColor = '#ff9800'; // 주황색 (500%)
    } else if (volumePercent <= 520) {
      gaugeColor = '#f44336'; // 빨간색 (520%)
    } else {
      gaugeColor = '#8b0000'; // 진홍색 (1000%)
    }
  }
  
  // 채움 영역 그리기
  ctx.fillStyle = gaugeColor;
  ctx.fillRect(0, height - fillHeight, width, fillHeight);
  
  // 테두리 그리기
  ctx.strokeStyle = '#e0e0e0';
  ctx.lineWidth = 2;
  ctx.strokeRect(1, 1, width - 2, height - 2);
}

// 색상 보간 함수 (RGB 색상 간 보간)
function interpolateColor(color1, color2, currentValue, minValue, maxValue) {
  // 16진수 색상을 RGB로 변환
  const hex1 = color1.replace('#', '');
  const hex2 = color2.replace('#', '');
  
  const r1 = parseInt(hex1.substr(0, 2), 16);
  const g1 = parseInt(hex1.substr(2, 2), 16);
  const b1 = parseInt(hex1.substr(4, 2), 16);
  
  const r2 = parseInt(hex2.substr(0, 2), 16);
  const g2 = parseInt(hex2.substr(2, 2), 16);
  const b2 = parseInt(hex2.substr(4, 2), 16);
  
  // 보간 비율 계산 (0.0 ~ 1.0)
  const ratio = (currentValue - minValue) / (maxValue - minValue);
  
  // RGB 값 보간
  const r = Math.round(r1 + (r2 - r1) * ratio);
  const g = Math.round(g1 + (g2 - g1) * ratio);
  const b = Math.round(b1 + (b2 - b1) * ratio);
  
  // RGB를 16진수로 변환
  const toHex = (n) => {
    const hex = n.toString(16);
    return hex.length === 1 ? '0' + hex : hex;
  };
  
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

// 볼륨 조절 함수
function updateVolume(volumePercent) {
  volumeLevel = volumePercent / 100.0; // 0-1000%를 0.0-10.0으로 변환
  volumeValue.textContent = `${Math.round(volumePercent)}%`;
  volumeDisplay.textContent = `${Math.round(volumePercent)}%`;
  
  // v4.0: 현재 활성 오디오 소스에 즉시 볼륨 적용
  updateCurrentVolume();
  
  // 게이지 그리기
  drawVolumeGauge(volumePercent);
  
  statusEl.textContent = `Volume: ${Math.round(volumePercent)}% (gain: ${volumeLevel.toFixed(2)})`;
}



// 시작/중지
btnStart.addEventListener('click', startAudio);
btnStopRealtime.addEventListener('click', stopAudio);

// 볼륨 게이지 이벤트
let isDragging = false;

volumeGauge.addEventListener('mousedown', (e) => {
  isDragging = true;
  const rect = volumeGauge.getBoundingClientRect();
  const y = e.clientY - rect.top;
  const volumePercent = calculateVolumeFromY(y, rect.height);
  updateVolume(volumePercent);
});

window.addEventListener('mousemove', (e) => {
  if (isDragging) {
    const rect = volumeGauge.getBoundingClientRect();
    const y = e.clientY - rect.top;
    const volumePercent = calculateVolumeFromY(y, rect.height);
    updateVolume(volumePercent);
  }
});

// Y 좌표를 볼륨 퍼센트로 변환하는 함수
function calculateVolumeFromY(y, height) {
  const normalizedY = 1 - (y / height); // 0(아래) ~ 1(위)
  
  if (normalizedY <= 0.5) {
    // 0-100%: 0에서 중간까지
    return Math.max(0, Math.min(100, normalizedY * 2 * 100));
  } else if (normalizedY <= 0.75) {
    // 100-500%: 중간에서 3/4까지
    const progress = (normalizedY - 0.5) / 0.25;
    return Math.max(100, Math.min(500, 100 + progress * 400));
  } else {
    // 500-1000%: 3/4에서 최대까지
    const progress = (normalizedY - 0.75) / 0.25;
    return Math.max(500, Math.min(1000, 500 + progress * 500));
  }
}

window.addEventListener('mouseup', () => {
  isDragging = false;
});

// 볼륨 게이지 우클릭 이벤트 (100%로 리셋)
volumeGauge.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  updateVolume(100);
  statusEl.textContent = 'Volume reset to 100%';
});

// 앱 초기화
(async function init() {
  try {
    await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (e) {
    // 사용자가 바로 허용하지 않더라도 장치 목록은 일부 보일 수 있음
  }
  await populateInputDevices();

  // 캔버스 크기 초기 설정
  resizeCanvas();

  // 윈도우 리사이즈 이벤트
  window.addEventListener('resize', () => {
    resizeCanvas();
  });
  
  // 초기 볼륨 게이지 그리기
  updateVolume(100);

  navigator.mediaDevices.addEventListener('devicechange', async () => {
    await populateInputDevices();
  });
})();

// ===================================
// v4.0: 파일 재생 기능
// ===================================

// v4.0: 파일 업로드 처리 (로딩 모달 포함)
fileInput.addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  
  try {
    // 로딩 모달 표시
    showLoadingModal();
    statusEl.textContent = 'Loading audio file...';
    
    // 현재 입력 중지
    stopCurrentInput();
    
    // 파일을 ArrayBuffer로 읽기
    const arrayBuffer = await file.arrayBuffer();
    
    // 오디오 컨텍스트 초기화 (필요시)
    if (!audioCtx) {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)({ 
        latencyHint: 'interactive',
        sampleRate: 48000
      });
    }
    
    // 오디오 버퍼로 디코딩
    fileBuffer = await audioCtx.decodeAudioData(arrayBuffer);
    fileDuration = fileBuffer.duration;
    
    // 공통 오디오 노드 초기화
    initializeAudioNodes();
    
    // 파일명 표시
    fileName.textContent = file.name;
    
    // 파일 모드로 전환
    switchToFileMode();
    
    // 타임라인 초기화
    totalTime.textContent = formatTime(fileDuration);
    currentTime.textContent = '00:00';
    drawTimelineGauge(0); // 게이지 초기화
    
    // v4.0: 파일 로드 완료 후 재생 버튼 활성화
    btnPlay.disabled = false;
    btnPause.disabled = true;
    btnStop.disabled = true;
    
    // 시각화 시작
    if (!lastFrameTime) {
      lastFrameTime = performance.now();
      requestAnimationFrame(drawLoop);
    }
    
    // 로딩 모달 숨김
    hideLoadingModal();
    statusEl.textContent = `File loaded: ${file.name} (${formatTime(fileDuration)})`;
    
  } catch (err) {
    // 로딩 모달 숨김 (에러 시에도)
    hideLoadingModal();
    statusEl.textContent = `Error loading file: ${err.message}`;
    console.error('File loading error:', err);
  }
});

// v4.0: setupFileMode는 switchToFileInput으로 대체됨

// v4.0: 파일 재생 (통합 구조)
function playFile() {
  if (!fileBuffer || !audioCtx) return;
  
  try {
    // 기존 파일 소스 정리
    if (fileSourceNode) {
      try {
        fileSourceNode.disconnect();
        // start()가 호출된 경우에만 stop() 호출
        if (fileSourceNode.context && fileSourceNode.context.state !== 'closed') {
          fileSourceNode.stop();
        }
      } catch (e) {
        console.warn('v4.0: Error stopping previous fileSourceNode:', e);
      }
      fileSourceNode = null;
    }
    
    // 새 버퍼 소스 노드 생성
    fileSourceNode = audioCtx.createBufferSource();
    fileSourceNode.buffer = fileBuffer;
    fileSourceNode.loop = isRepeating;
    
    // 통합 파이프라인에 연결
    currentSourceNode = fileSourceNode;
    connectAudioPipeline();
    
    // 재생 시작 (게이지에서 현재 진행률 계산)
    const currentProgress = getCurrentTimelineProgress();
    const startTime = (currentProgress / 100) * fileDuration;
    fileSourceNode.start(0, startTime);
    
    // 재생 상태 업데이트
    isPlaying = true;
    btnPlay.disabled = true;
    btnPause.disabled = false;
    btnStop.disabled = false;
    
    // 시간 업데이트 시작
    startTimeUpdate();
    
    // 재생 완료 시 처리
    fileSourceNode.onended = () => {
      if (!isRepeating) {
        pauseFile(); // stopFile 대신 pauseFile 사용
      }
    };
    
    statusEl.textContent = 'Playing file...';
    console.log('v4.0: File playback started (unified pipeline)');
    
  } catch (err) {
    statusEl.textContent = `Playback error: ${err.message}`;
    console.error('Playback error:', err);
  }
}

// 파일 일시정지
function pauseFile() {
  if (fileSourceNode && isPlaying) {
    try {
      fileSourceNode.disconnect();
      fileSourceNode.stop();
    } catch (e) {
      console.warn('v4.0: Error stopping fileSourceNode in pauseFile:', e);
    }
    fileSourceNode = null;
    
    isPlaying = false;
    btnPlay.disabled = false;
    btnPause.disabled = true;
    
    stopTimeUpdate();
    statusEl.textContent = 'Paused';
    console.log('v4.0: File playback paused');
  }
}

// v4.0: 파일 정지 (타임바를 00:00으로 되돌림)
function stopFile() {
  if (fileSourceNode) {
    try {
      fileSourceNode.disconnect();
      fileSourceNode.stop();
    } catch (e) {
      console.warn('v4.0: Error stopping fileSourceNode in stopFile:', e);
    }
    fileSourceNode = null;
  }
  
  isPlaying = false;
  btnPlay.disabled = false;
  btnPause.disabled = true;
  btnStop.disabled = true;
  
  // 타임라인 처음으로 (요구사항)
  drawTimelineGauge(0);
  currentTime.textContent = '00:00';
  
  stopTimeUpdate();
  
  statusEl.textContent = 'File stopped - Ready to play';
  console.log('v4.0: File playbook stopped, timeline reset to 00:00');
}

// v4.0: 파일 모드 종료 및 실시간 모드 복귀 (통합 구조)
function exitFileMode() {
  stopCurrentInput();
  switchToRealtimeInput();
  
  console.log('v4.0: Exited file mode via unified structure');
}

// v4.0: connectFileGraph는 통합 파이프라인으로 대체됨

// 시간 업데이트
let timeUpdateInterval = null;
let playStartTime = 0;
let pausedTime = 0;

function startTimeUpdate() {
  playStartTime = audioCtx.currentTime;
  pausedTime = (timelineSlider.value / 100) * fileDuration;
  
  timeUpdateInterval = setInterval(() => {
    if (isPlaying && audioCtx) {
      const elapsed = audioCtx.currentTime - playStartTime + pausedTime;
      const progress = Math.min(elapsed / fileDuration, 1) * 100;
      
      drawTimelineGauge(progress);
      currentTime.textContent = formatTime(elapsed);
      
      // 재생 완료 확인
      if (elapsed >= fileDuration && !isRepeating) {
        stopFile();
      }
    }
  }, 100);
}

function stopTimeUpdate() {
  if (timeUpdateInterval) {
    clearInterval(timeUpdateInterval);
    timeUpdateInterval = null;
  }
}

// v4.0: 타임라인 캔버스가 제거되어 drawTimeline 함수도 제거됨

// 시간 포맷팅
function formatTime(seconds) {
  const minutes = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
}

// 반복 모드 토글
function toggleRepeat() {
  isRepeating = !isRepeating;
  btnRepeat.classList.toggle('on', isRepeating);
  btnRepeat.textContent = isRepeating ? '🔁 반복' : '🔁 반복';
  
  if (fileSourceNode) {
    fileSourceNode.loop = isRepeating;
  }
  
  console.log('v4.0: Repeat mode:', isRepeating);
}

// v4.0: 새로운 모드 버튼 이벤트 리스너
btnModeRealtime.addEventListener('click', switchToRealtimeMode);
btnModeFile.addEventListener('click', switchToFileMode);

// 파일 재생 컨트롤 이벤트 리스너
btnPlay.addEventListener('click', playFile);
btnPause.addEventListener('click', pauseFile);
btnStop.addEventListener('click', stopFile);
btnRepeat.addEventListener('click', toggleRepeat);

// v4.0: 타임라인 게이지 클릭 이벤트
timelineGauge.addEventListener('click', (e) => {
  if (inputMode === 'file' && fileDuration > 0) {
    const rect = timelineGauge.getBoundingClientRect();
    const clickX = e.clientX - rect.left;
    const progress = (clickX / rect.width) * 100;
    
    // 0-100% 범위로 제한
    const clampedProgress = Math.max(0, Math.min(100, progress));
    
    const seekTime = (clampedProgress / 100) * fileDuration;
    currentTime.textContent = formatTime(seekTime);
    
    // 게이지 업데이트
    drawTimelineGauge(clampedProgress);
    
    // 재생 위치 이동
    seekToPosition(clampedProgress);
    
    console.log(`v4.0: Timeline gauge clicked at ${clampedProgress.toFixed(1)}%`);
  }
});

// 지정된 위치로 재생 위치 이동
function seekToPosition(progressPercent) {
  if (inputMode !== 'file' || !fileBuffer) return;
  
  const wasPlaying = isPlaying;
  
  // 재생 중이면 일시정지
  if (isPlaying) {
    pauseFile();
  }
  
  // 타임라인 업데이트
  const seekTime = (progressPercent / 100) * fileDuration;
  currentTime.textContent = formatTime(seekTime);
  drawTimelineGauge(progressPercent);
  
  // 재생 중이었으면 새 위치에서 재시작
  if (wasPlaying) {
    setTimeout(() => playFile(), 100);
  }
  
  console.log(`v4.0: Seeked to ${seekTime.toFixed(2)}s (${progressPercent.toFixed(1)}%)`);
}

console.log('v4.0: File playback system initialized');

// 기능 설명 주석:
// - 스펙트럼 배경, 그리드(주/보조), X/Y축 눈금/라벨을 그립니다.
// - X축은 20/50/100/200/500/1k/2k/5k/10k/20k Hz의 "1-2-5" 시퀀스로 표시
// - Y축은 dBFS -120 ~ 0 사이, 주눈금 10 dB, 보조 5 dB

function drawSpecGridAndAxes(ctx, width, height) {
  // 고정 패딩 설정 (픽셀 단위) - 좌측 라벨 영역 제거
  const padding = { top: 10, right: 10, bottom: 40, left: 0 };
  const plotWidth = width - padding.left - padding.right;
  const plotHeight = height - padding.top - padding.bottom;
  const plotX = padding.left;
  const plotY = padding.top;

  // 배경
  ctx.fillStyle = '#0e0f14';
  ctx.fillRect(0, 0, width, height);

  // 색상(연한 회색)
  const minor = 'rgba(220,220,220,0.15)';
  const major = 'rgba(220,220,220,0.30)';
  const label = '#cfd2d6';

  // Y축(dBFS) 그리드/라벨
  const minDb = -120, maxDb = 0;
  for (let db = minDb; db <= maxDb; db += 5) {
    const y = plotY + dbToY(db, plotHeight);
    ctx.strokeStyle = (db % 10 === 0) ? major : minor;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(plotX, Math.round(y) + 0.5);
    ctx.lineTo(plotX + plotWidth, Math.round(y) + 0.5);
    ctx.stroke();

    // 10 dB마다 라벨 (그래프 안쪽으로)
    if (db % 10 === 0) {
      ctx.fillStyle = label;
      ctx.font = '11px system-ui, sans-serif';
      ctx.textBaseline = 'middle';
      ctx.textAlign = 'left';
      ctx.fillText(`${db}`, plotX + 5, y);
    }
  }

  // v4.0.1: 통일된 주파수 모듈 사용
  const frequencyValues = getGridFrequencyValues();
  
  // 통일된 변환 함수로 정확한 X좌표 계산
  for (let i = 0; i < frequencyValues.length; i++) {
    const f = frequencyValues[i];
    const x = plotX + hzToCanvasX(f, plotWidth);
    
    ctx.strokeStyle = major;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(Math.round(x) + 0.5, plotY);
    ctx.lineTo(Math.round(x) + 0.5, plotY + plotHeight);
    ctx.stroke();

    // 라벨 (그리드 바깥으로) - 겹침 방지를 위한 위치 조정
    ctx.fillStyle = label;
    ctx.font = '11px system-ui, sans-serif';
    ctx.textBaseline = 'top';
    ctx.textAlign = 'center';
    const txt = (f >= 1000) ? `${Math.round(f/1000)}k` : `${f}`;
    
    // 라벨 위치 계산 (겹침 방지)
    let labelX = x;
    let labelY = plotY + plotHeight + 8;
    
    // 짧은 텍스트는 기본 위치, 긴 텍스트는 약간 위로
    if (txt.length > 2) {
      labelY = plotY + plotHeight + 4;
    }
    
    // 첫 번째와 마지막 라벨은 항상 표시
    if (i === 0 || i === frequencyValues.length - 1) {
      ctx.fillText(txt, labelX, labelY);
    } else {
      // 중간 라벨들은 조건부 표시 (너무 가까우면 생략)
      const prevFreq = frequencyValues[i - 1];
      const prevX = plotX + hzToCanvasX(prevFreq, plotWidth);
      const minDistance = 35; // 최소 35픽셀 간격
      if (x - prevX >= minDistance) {
        ctx.fillText(txt, labelX, labelY);
      }
    }
  }

  // 축 제목
  ctx.fillStyle = label;
  ctx.font = '12px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('Frequency (Hz)', plotX + plotWidth / 2, height - 5);
  
  // Y축 제목
  ctx.save();
  ctx.translate(15, plotY + plotHeight / 2);
  ctx.rotate(-Math.PI / 2);
  ctx.fillText('Amplitude (dBFS)', 0, 0);
  ctx.restore();

  // 플롯 영역 반환 (다른 함수에서 사용)
  return { plotX, plotY, plotWidth, plotHeight };
}

// v4.0: 초기화 및 디버깅
window.addEventListener('load', () => {
  console.log('v4.0: Page loaded, initializing...');
  console.log(`v4.0: Initial state - audioCtx: ${!!audioCtx}, visualAnalyser: ${!!visualAnalyser}, inputMode: ${inputMode}`);
  
  // 입력 디바이스 나열
  populateInputDevices().catch(err => {
    console.error('v4.0: Error populating input devices:', err);
  });
  
  // 캔버스 크기 조정
  resizeCanvas();
  
  console.log('v4.0: Initialization complete');
});

// populateInputDevices 함수가 정의되지 않았다면 추가
async function populateInputDevices() {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    inputSelect.innerHTML = '';
    devices
      .filter(d => d.kind === 'audioinput')
      .forEach((d, i) => {
        const opt = document.createElement('option');
        opt.value = d.deviceId;
        opt.textContent = `${d.label || 'Audio Input ' + (i+1)}`;
        inputSelect.appendChild(opt);
      });
    console.log(`v4.0: Found ${devices.filter(d => d.kind === 'audioinput').length} audio input devices`);
  } catch (err) {
    console.error('v4.0: Error enumerating devices:', err);
  }
}
