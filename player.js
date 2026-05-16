// player.js
// -------------------------------------------------------
// MRIT Player â€“ vÃ­deo com CORS/Range-friendly + cache por tela
// - cache por cÃ³digo de tela (namespaced)
// - informa namespace ao SW e limpa quando sai de uso
// - remove HEAD em vÃ­deos (evita 403 falsos)
// - seta crossorigin="anonymous" antes de tocar
// - limpa src/load entre trocas
// -------------------------------------------------------

const supabaseUrl = "https://base.muraltv.com.br";
const supabaseKey = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJyb2xlIjoiYW5vbiIsImlzcyI6InN1cGFiYXNlIiwiaWF0IjoxNzUyODA3NjAwLCJleHAiOjE5MTA1NzQwMDB9.P4goMdCvXKPk9ViLYlSUk7nR_zeW3yUw5ixjv7Mk99g";
const client = supabase.createClient(supabaseUrl, supabaseKey);

// ===== Constantes/estado =====

// ===== ConfiguraÃ§Ãµes de Buffering =====
// Modos disponÃ­veis:
// - "progressive": Espera buffer mÃ­nimo antes de tocar (recomendado - melhor equilÃ­brio)
// - "full": Espera carregar 100% antes de tocar (mais seguro, mas mais lento)
// - "immediate": Toca assim que possÃ­vel (mais rÃ¡pido, pode travar em conexÃµes lentas)
const BUFFERING_MODE = "progressive"; // ou "full" ou "immediate"
const MIN_BUFFER_SECONDS = 2; // usado apenas no modo "progressive"
const ITEM_FAILURE_COOLDOWN_MS = 180000; // 3 min
const ITEM_FAILURES_BEFORE_COOLDOWN = 2;
const REDUCED_MEDIA_MODE_KEY = "mrit_reduced_media_mode_v1";
// Modo nativo (ExoPlayer) no APK:
// - ENABLE_NATIVE_EXO_DEFAULT: tenta usar player nativo quando disponível
// - NATIVE_ANDROID_NATIVE_MEDIA_ONLY: se true, obriga SEMPRE modo nativo (sem fallback web)
// Para evitar tela preta em dispositivos/boxes onde o plugin nativo falha, deixamos
// o modo nativo opcional, com fallback automático para o player web/HTML5.
const ENABLE_NATIVE_EXO_DEFAULT = true;
const NATIVE_ANDROID_NATIVE_MEDIA_ONLY = false;

let playlist = [];
let currentIndex = 0;
let currentPlaylistId = null;
let codigoAtual = null;
let currentContentCode = null;
let displaysChannel = null;
let playlistChannel = null;
let dispositivosChannel = null;
let dispositivosCheckTimer = null;
let deviceCommandsChannel = null;
let promoChannel = null;
let cacheCheckTimer = null;
let playToken = 0;
let currentItemUrl = null;
let isPlaying = false;
let realtimeReady = false;
let onlineDebounceId = null;
let pendingResync = false;
let awaitingServerRecovery = false;
let lastCycleRefreshAt = 0;
let videoRetryCount = 0;
const MAX_VIDEO_RETRIES = 3;
let isLoadingVideo = false;
let currentVideoToken = 0;
let cycleCheckInFlight = false;
let preloadedBufferUrl = null;
let preloadingBuffer = false;
let lastFailedUrl = null;
let lastFailedRetries = 0;
let lastShortEndUrl = null;
let lastShortEndRetries = 0;
let playbackWatchdogTimer = null;
let feedTimer        = null;
let feedSlideTimer   = null;
let feedClockInt     = null;
let feedItems        = [];
let feedArticlesFull = [];
let feedOffsets      = {}; // { query: nextStartIndex }
let feedCurrent      = 0;
let feedSlidesShown  = 0;
let feedCurrentQuery = null;
let isFirstCycle = true; // Rastreia se é o primeiro ciclo da playlist
let activeMediaItem = null;
let activeMediaType = null;
const itemFailureState = new Map();
const videoCacheRepairState = new Map();
const VIDEO_DURATION_STORAGE_KEY = "mrit_video_duration_map_v1";
const DISPLAY_ORIENTATION_STORAGE_KEY = "mrit_display_orientation_v1";
const VIDEO_STALL_RECACHE_TOLERANCE_SECONDS = 1.5;
const VIDEO_CACHE_REPAIR_COOLDOWN_MS = 120000;
let weakDeviceDetected = false;
let reducedMediaMode = false;
let nativeExoListenerHandle = null;
let nativeExoPendingToken = null;
let nativeExoPendingUrl = null;
const activeObjectUrls = new Set();
// ===== VariÃ¡veis de promoÃ§Ã£o =====
let promoData = null;
let promoCounter = null;
let promoPopup = null;

let video = document.getElementById("videoPlayer");
let videoBuffer = document.getElementById("videoPlayerB") || video;
const img = document.getElementById("imgPlayer");

function getUniqueVideoEls() {
  const out = [];
  if (video) out.push(video);
  if (videoBuffer && videoBuffer !== video) out.push(videoBuffer);
  return out;
}

function restoreMediaLayerStyles() {
  for (const v of getUniqueVideoEls()) {
    v.style.zIndex = "1";
    v.style.opacity = "1";
  }
  if (img) {
    img.style.zIndex = "1";
    img.style.opacity = "1";
  }
}

function stopPlaybackWatchdog() {
  if (playbackWatchdogTimer) {
    clearInterval(playbackWatchdogTimer);
    playbackWatchdogTimer = null;
  }
}

function getItemFailureEntry(url) {
  if (!url) return null;
  return itemFailureState.get(url) || null;
}

function isItemOnCooldown(url) {
  const entry = getItemFailureEntry(url);
  if (!entry || !entry.cooldownUntil) return false;
  if (Date.now() >= entry.cooldownUntil) {
    itemFailureState.delete(url);
    return false;
  }
  return true;
}

function registerItemFailure(url, reason = "unknown") {
  if (!url) return;
  const now = Date.now();
  const prev = getItemFailureEntry(url) || { failures: 0, cooldownUntil: 0, lastReason: null };
  const nextFailures = prev.failures + 1;
  const next = {
    failures: nextFailures,
    cooldownUntil: prev.cooldownUntil || 0,
    lastReason: reason,
  };
  if (nextFailures >= ITEM_FAILURES_BEFORE_COOLDOWN) {
    next.cooldownUntil = now + ITEM_FAILURE_COOLDOWN_MS;
  }
  itemFailureState.set(url, next);
  if (next.cooldownUntil > now) {
    const secs = Math.max(1, Math.round((next.cooldownUntil - now) / 1000));
    console.warn("[playback] cooling down item for", secs, "s:", url, "reason:", reason);
  }
}

function clearItemFailure(url) {
  if (!url) return;
  if (itemFailureState.has(url)) itemFailureState.delete(url);
}

function toFiniteNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function loadReducedMediaMode() {
  try {
    return localStorage.getItem(REDUCED_MEDIA_MODE_KEY) === "1";
  } catch {
    return false;
  }
}

function saveReducedMediaMode(value) {
  try {
    localStorage.setItem(REDUCED_MEDIA_MODE_KEY, value ? "1" : "0");
  } catch {}
}

function evaluateWeakDeviceProfile() {
  const memory = toFiniteNumber(navigator.deviceMemory, 0);
  const cores = toFiniteNumber(navigator.hardwareConcurrency, 0);
  const ua = String(navigator.userAgent || "").toLowerCase();
  const isAndroid = ua.includes("android");

  if (memory > 0 && memory <= 2) return true;
  if (cores > 0 && cores <= 4) return true;
  if (isAndroid && memory > 0 && memory <= 3 && cores > 0 && cores <= 8) return true;
  return false;
}

function shouldPreferReducedMedia() {
  return !!(weakDeviceDetected || reducedMediaMode);
}

function enableReducedMediaMode(reason = "unknown") {
  if (reducedMediaMode) return;
  reducedMediaMode = true;
  saveReducedMediaMode(true);
  console.warn("🐢 Modo de mídia reduzida ativado:", reason);
}

function initializeAdaptivePlaybackMode() {
  weakDeviceDetected = evaluateWeakDeviceProfile();
  reducedMediaMode = loadReducedMediaMode();
  if (weakDeviceDetected) {
    console.warn("🐢 Dispositivo classificado como mais fraco; player vai preferir modo leve");
  }
}

function pickNamedUrl(item, keys) {
  if (!item || !Array.isArray(keys)) return "";
  for (const key of keys) {
    const value = item[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

function pickSourceForOrientationAndTier(item, tier = "default") {
  const normalizedTier = String(tier || "default").toLowerCase();
  if (normalizedTier === "low") {
    if (ORIENTATION === "portrait") {
      return pickNamedUrl(item, ["urlPortraitLow", "url_portrait_low", "urlLowPortrait", "url_low_portrait"]) ||
        pickNamedUrl(item, ["urlLow", "url_low"]) ||
        pickSourceForOrientationAndTier(item, "default");
    }
    if (ORIENTATION === "landscape") {
      return pickNamedUrl(item, ["urlLandscapeLow", "url_landscape_low", "urlLowLandscape", "url_low_landscape"]) ||
        pickNamedUrl(item, ["urlLow", "url_low"]) ||
        pickSourceForOrientationAndTier(item, "default");
    }
    return pickNamedUrl(item, ["urlLow", "url_low"]) || pickSourceForOrientationAndTier(item, "default");
  }

  if (normalizedTier === "medium") {
    if (ORIENTATION === "portrait") {
      return pickNamedUrl(item, ["urlPortraitMedium", "url_portrait_medium", "urlMediumPortrait", "url_medium_portrait"]) ||
        pickNamedUrl(item, ["urlMedium", "url_medium"]) ||
        pickSourceForOrientationAndTier(item, "default");
    }
    if (ORIENTATION === "landscape") {
      return pickNamedUrl(item, ["urlLandscapeMedium", "url_landscape_medium", "urlMediumLandscape", "url_medium_landscape"]) ||
        pickNamedUrl(item, ["urlMedium", "url_medium"]) ||
        pickSourceForOrientationAndTier(item, "default");
    }
    return pickNamedUrl(item, ["urlMedium", "url_medium"]) || pickSourceForOrientationAndTier(item, "default");
  }

  if (ORIENTATION === "portrait" && item.urlPortrait) return item.urlPortrait;
  if (ORIENTATION === "landscape" && item.urlLandscape) return item.urlLandscape;
  return item.url;
}

function loadStoredVideoDurationMap() {
  try {
    const raw = localStorage.getItem(VIDEO_DURATION_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function saveStoredVideoDurationMap(map) {
  try {
    localStorage.setItem(VIDEO_DURATION_STORAGE_KEY, JSON.stringify(map || {}));
  } catch {}
}

function rememberVideoDuration(url, durationSeconds) {
  if (!url || !Number.isFinite(durationSeconds) || durationSeconds <= 0) return;
  const map = loadStoredVideoDurationMap();
  const rounded = Math.round(durationSeconds * 1000) / 1000;
  for (const candidate of buildCacheLookupCandidates(url)) {
    map[candidate] = rounded;
  }
  saveStoredVideoDurationMap(map);
}

function getRememberedVideoDuration(url) {
  if (!url) return null;
  const map = loadStoredVideoDurationMap();
  for (const candidate of buildCacheLookupCandidates(url)) {
    const duration = Number(map[candidate] || 0);
    if (Number.isFinite(duration) && duration > 0) return duration;
  }
  return null;
}

async function readVideoDurationFromBlob(blob) {
  if (!blob || blob.size <= 0) return null;
  return new Promise((resolve) => {
    const probe = document.createElement("video");
    const objectUrl = URL.createObjectURL(blob);
    let done = false;

    const finish = (value = null) => {
      if (done) return;
      done = true;
      probe.removeAttribute("src");
      try { probe.load(); } catch {}
      try { URL.revokeObjectURL(objectUrl); } catch {}
      resolve(value);
    };

    probe.preload = "metadata";
    probe.muted = true;
    probe.playsInline = true;
    probe.onloadedmetadata = () => finish(Number.isFinite(probe.duration) && probe.duration > 0 ? probe.duration : null);
    probe.onerror = () => finish(null);
    setTimeout(() => finish(null), 8000);
    probe.src = objectUrl;
  });
}

async function deleteCachedVideoEntries(url) {
  if (!url) return 0;
  const candidates = buildCacheLookupCandidates(url);
  const keys = await idbAllKeys();
  let deleted = 0;

  for (const rawKey of keys) {
    const key = String(rawKey);
    if (!candidates.some((candidate) => key.endsWith(`::${candidate}`))) continue;
    await idbDel(key);
    deleted++;
  }

  return deleted;
}

async function repairVideoCacheInBackground(url, reason = "unknown") {
  if (!codigoAtual || !url || !navigator.onLine) return false;

  const now = Date.now();
  const state = videoCacheRepairState.get(url) || { inFlight: false, lastAttemptAt: 0 };
  if (state.inFlight) return false;
  if (state.lastAttemptAt && (now - state.lastAttemptAt) < VIDEO_CACHE_REPAIR_COOLDOWN_MS) return false;

  state.inFlight = true;
  state.lastAttemptAt = now;
  videoCacheRepairState.set(url, state);

  try {
    console.warn("🔧 Refazendo cache do vídeo em background:", { url, reason });
    const response = await fetch(url, { method: "GET", cache: "no-store" });
    if (!response.ok) throw new Error(`status_${response.status}`);

    const blob = await response.blob();
    if (!blob || blob.size <= 0) throw new Error("blob_vazio");

    const detectedDuration = await readVideoDurationFromBlob(blob);
    if (detectedDuration) rememberVideoDuration(url, detectedDuration);

    await deleteCachedVideoEntries(url);
    await idbSet(`${codigoAtual}::${url}`, blob);
    console.log("✅ Cache do vídeo reparado:", url, "bytes:", blob.size);
    return true;
  } catch (err) {
    console.warn("⚠️ Falha ao reparar cache do vídeo:", url, err?.message || err);
    return false;
  } finally {
    const latestState = videoCacheRepairState.get(url) || state;
    latestState.inFlight = false;
    videoCacheRepairState.set(url, latestState);
  }
}

function isNativeAndroid() {
  try {
    return !!window.Capacitor &&
      typeof window.Capacitor.getPlatform === "function" &&
      window.Capacitor.getPlatform() === "android" &&
      typeof window.Capacitor.isNativePlatform === "function" &&
      window.Capacitor.isNativePlatform();
  } catch {
    return false;
  }
}

function isNativeExoEnabled() {
  try {
    const raw = localStorage.getItem("mrit_use_native_exo");
    if (raw === "1" || raw === "true") return true;
    if (raw === "0" || raw === "false") return false;
  } catch {}
  return ENABLE_NATIVE_EXO_DEFAULT && isNativeAndroid();
}

function getNativeExoPlugin() {
  try {
    return window.Capacitor?.Plugins?.MritExoPlayer || null;
  } catch {
    return null;
  }
}

function nativeCallWithTimeout(promise, ms = 1500) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error("native timeout")), ms))
  ]);
}

function isNativeMediaModeActive() {
  return isNativeAndroid() && isNativeExoEnabled() && NATIVE_ANDROID_NATIVE_MEDIA_ONLY;
}

function setPlayerMode(mode) {
  if (document.body) {
    document.body.dataset.playerMode = mode;
  }
}

async function ensureNativeExoListener() {
  if (!isNativeExoEnabled()) return;
  const plugin = getNativeExoPlugin();
  if (!plugin || nativeExoListenerHandle) return;
  try {
    nativeExoListenerHandle = await plugin.addListener("state", (event) => {
      const state = event?.state;
      const token = event?.token ?? null;
      const url = event?.url || nativeExoPendingUrl;
      if (token === null || token !== String(nativeExoPendingToken)) return;

      if (state === "ended") {
        clearItemFailure(url);
        isPlaying = false;
        stopPlaybackWatchdog();
        proximoItem();
        verificarMudancasPosTrocaEmBackground();
      } else if (state === "image_ready") {
        clearItemFailure(url);
      } else if (state === "error") {
        registerItemFailure(url, "native_exo_error");
        isPlaying = false;
        stopPlaybackWatchdog();
        if (lastFailedUrl === url) {
          lastFailedRetries += 1;
        } else {
          lastFailedUrl = url;
          lastFailedRetries = 1;
        }
        if (lastFailedRetries > 1) {
          lastFailedUrl = null;
          lastFailedRetries = 0;
          proximoItem();
        } else {
          setTimeout(() => tocarLoop(), 150);
        }
      } else if (state === "image_error") {
        registerItemFailure(url, "native_image_error");
        isPlaying = false;
        proximoItem();
      }
    });
  } catch (err) {
    console.warn("Native Exo listener unavailable:", err?.message || err);
  }
}

async function stopNativeVideoPlayback() {
  if (!isNativeExoEnabled()) return;
  const plugin = getNativeExoPlugin();
  nativeExoPendingToken = null;
  nativeExoPendingUrl = null;
  if (!plugin) return;
  try {
    await nativeCallWithTimeout(plugin.stop(), 1200);
  } catch {}
}

async function tryPlayWithNativeExo(item, itemUrl, token) {
  if (!isNativeAndroid() || !isNativeExoEnabled()) return false;
  const plugin = getNativeExoPlugin();
  if (!plugin) return false;
  try {
    await ensureNativeExoListener();
    // Primeiro ciclo: sempre usar internet direta (sem cache)
    // Após primeiro ciclo: permitir cache para melhor performance
    // TV boxes: sempre sem cache (já tratado no plugin nativo)
    const useCache = !isFirstCycle;
    const fit = getOrientationFromSelectedSource(item, itemUrl) === ORIENTATION ? "cover" : "contain";
    nativeExoPendingToken = token;
    nativeExoPendingUrl = itemUrl;
    await nativeCallWithTimeout(plugin.play({
      url: itemUrl,
      fit,
      muted: true,
      useCache,
      token: String(token),
    }), 2000);
    console.log("[native-exo] play requested:", itemUrl, "useCache=", useCache, "isFirstCycle=", isFirstCycle);
    for (const v of getUniqueVideoEls()) {
      v.style.display = "none";
    }
    img.style.display = "none";
    img.src = "";
    clearItemFailure(itemUrl);
    isPlaying = true;
    isLoadingVideo = false;
    return true;
  } catch (err) {
    console.warn("[native-exo] play failed, fallback to HTML video:", err?.message || err);
    nativeExoPendingToken = null;
    nativeExoPendingUrl = null;
    return false;
  }
}

async function tryShowImageNative(item, itemUrl, token) {
  if (!isNativeAndroid() || !isNativeExoEnabled()) return false;
  const plugin = getNativeExoPlugin();
  if (!plugin) return false;
  try {
    await ensureNativeExoListener();
    const sourceOrientation = getOrientationFromSelectedSource(item, itemUrl);
    const fit = sourceOrientation ? (sourceOrientation === ORIENTATION ? "cover" : "contain") : (FIT_RULES[ORIENTATION]?.image || "cover");
    nativeExoPendingToken = token;
    nativeExoPendingUrl = itemUrl;
    await nativeCallWithTimeout(plugin.showImage({
      url: itemUrl,
      fit,
      token: String(token),
    }), 2500);
    clearItemFailure(itemUrl);
    isPlaying = true;
    return true;
  } catch (err) {
    console.warn("[native-media] image failed:", err?.message || err);
    nativeExoPendingToken = null;
    nativeExoPendingUrl = null;
    return false;
  }
}

function startPlaybackWatchdog(videoEl, token, itemUrl) {
  stopPlaybackWatchdog();
  let lastTime = -1;
  let lastProgressAt = Date.now();

  playbackWatchdogTimer = setInterval(() => {
    if (token !== playToken) {
      stopPlaybackWatchdog();
      return;
    }
    if (!videoEl || videoEl.style.display === "none" || videoEl.paused) return;

    const t = Number(videoEl.currentTime || 0);
    if (t > lastTime + 0.05) {
      lastTime = t;
      lastProgressAt = Date.now();
      return;
    }

    const stalledForMs = Date.now() - lastProgressAt;
    if (stalledForMs >= 7000) {
      const rememberedDuration = getRememberedVideoDuration(itemUrl);
      const detectedDuration = Number(videoEl.duration || 0);
      const expectedDuration = rememberedDuration || (Number.isFinite(detectedDuration) && detectedDuration > 0 ? detectedDuration : null);
      const stalledBeforeExpectedEnd = expectedDuration && (t + VIDEO_STALL_RECACHE_TOLERANCE_SECONDS) < expectedDuration;
      if (stalledBeforeExpectedEnd || weakDeviceDetected) {
        enableReducedMediaMode(`stall_watchdog:${itemUrl}`);
      }
      console.warn("⚠️ Vídeo travado por muito tempo, pulando item:", itemUrl);
      stopPlaybackWatchdog();
      isPlaying = false;
      try { videoEl.pause(); } catch {}
      registerItemFailure(itemUrl, "stall_watchdog");
      if (stalledBeforeExpectedEnd) {
        repairVideoCacheInBackground(itemUrl, `stall_before_expected_end_${t.toFixed(2)}s_of_${expectedDuration.toFixed(2)}s`).catch(() => {});
      }
      proximoItem();
      verificarMudancasPosTrocaEmBackground();
    }
  }, 1000);
}

function isVideoItem(item, itemUrl) {
  const tipo = (item?.tipo || "").toLowerCase();
  return /\.m3u8(\?|$)/i.test(itemUrl) ||
    tipo.includes("video") ||
    /\.(mp4|webm|mkv|mov|avi|m4v|3gp|flv|wmv)(\?|$)/i.test(itemUrl);
}

function isImageItem(item, itemUrl) {
  const tipo = (item?.tipo || "").toLowerCase();
  return tipo.includes("imagem") ||
    tipo.includes("image") ||
    /\.(jpg|jpeg|png|webp|gif|bmp|avif)(\?|$)/i.test(itemUrl);
}

async function nativePreloadUpcomingItem(baseIndex) {
  if (!isNativeMediaModeActive()) return;
  const plugin = getNativeExoPlugin();
  if (!plugin || !Array.isArray(playlist) || playlist.length < 2) return;
  if (shouldPreferReducedMedia()) return;
  
  // Primeiro ciclo: não pré-carregar (usar internet direta)
  if (isFirstCycle) return;

  try {
    const nextIndex = (baseIndex + 1) % playlist.length;
    const nextItem = playlist[nextIndex];
    if (!nextItem || !nextItem.url) return;
    const nextUrl = pickSourceForOrientation(nextItem);
    if (!nextUrl || isItemOnCooldown(nextUrl)) return;

    const tipo = isImageItem(nextItem, nextUrl) ? "imagem" : "video";
    // Após primeiro ciclo: permitir pré-carregamento de vídeos também
    if (tipo === "video") {
      // Pré-carregar vídeo apenas após primeiro ciclo
      await nativeCallWithTimeout(plugin.preload({
        url: nextUrl,
        tipo,
        token: String(playToken || 0),
      }), 1000);
    } else {
      await nativeCallWithTimeout(plugin.preload({
        url: nextUrl,
        tipo,
        token: String(playToken || 0),
      }), 1000);
    }
  } catch {
    // best effort
  }
}

async function preloadUpcomingVideoInBuffer(baseIndex) {
  try {
    // Primeiro ciclo: não pré-carregar (usar internet direta)
    if (isFirstCycle) return;
    if (shouldPreferReducedMedia()) return;
    
    if (preloadingBuffer || !playlist.length) return;
    const preloadEl = (videoBuffer && videoBuffer !== video) ? videoBuffer : null;
    if (!preloadEl) return;

    const nextIndex = (baseIndex + 1) % playlist.length;
    const nextItem = playlist[nextIndex];
    if (!nextItem || !nextItem.url) return;
    const nextUrl = pickSourceForOrientation(nextItem);
    if (!nextUrl) return;
    if (!isVideoItem(nextItem, nextUrl)) return;
    if (/\.m3u8(\?|$)/i.test(nextUrl)) return; // HLS segue fluxo normal
    if (preloadedBufferUrl === nextUrl && preloadEl.readyState >= 2) return;

    preloadingBuffer = true;
    preloadEl.onended = null;
    try { preloadEl.pause(); } catch {}
    try { preloadEl.currentTime = 0; } catch {}
    preloadEl.setAttribute("crossorigin", "anonymous");
    preloadEl.preload = "auto";
    preloadEl.muted = true;
    preloadEl.playsInline = true;
    preloadEl.src = nextUrl;
    preloadEl.load();
    const ok = await waitForCanPlay(preloadEl, 1500);
    if (ok) preloadedBufferUrl = nextUrl;
  } catch {
    // best effort
  } finally {
    preloadingBuffer = false;
  }
}

// ===== Constantes para localStorage =====
const CODIGO_DISPLAY_KEY = 'mrit_display_codigo';
const LOCAL_TELA_KEY = 'mrit_local_tela';
const DEVICE_ID_KEY = 'mrit_device_id';
const RESTARTING_KEY = 'mrit_is_restarting'; // sessionStorage - indica que estÃ¡ reiniciando
const DISPOSITIVO_STALE_MS = 15 * 60 * 1000;

// ===== Gerar ID Ãºnico do dispositivo =====
// IMPORTANTE: O device_id deve ser PERSISTENTE e ÃšNICO por dispositivo fÃ­sico
// NÃƒO deve mudar mesmo apÃ³s reinstalar o app ou limpar cache
function gerarDeviceId() {
  let deviceId = localStorage.getItem(DEVICE_ID_KEY);
  
  if (!deviceId) {
    // Gerar um ID Ãºnico baseado em caracterÃ­sticas do dispositivo
    // NÃƒO usar Date.now() para garantir que seja sempre o mesmo
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    ctx.textBaseline = 'top';
    ctx.font = '14px "Arial"';
    ctx.textBaseline = 'alphabetic';
    ctx.fillText('Device fingerprint', 2, 2);
    
    // Fingerprint baseado em caracterÃ­sticas permanentes do dispositivo
    const fingerprint = [
      navigator.userAgent,
      navigator.language,
      screen.width + 'x' + screen.height,
      new Date().getTimezoneOffset(),
      navigator.hardwareConcurrency || '0',
      navigator.deviceMemory || '0',
      canvas.toDataURL()
    ].join('|');
    
    // Criar hash simples do fingerprint (sem timestamp)
    let hash = 0;
    for (let i = 0; i < fingerprint.length; i++) {
      const char = fingerprint.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash; // Convert to 32bit integer
    }
    
    // Gerar ID baseado apenas no hash (SEM Date.now() para garantir persistÃªncia)
    deviceId = 'device_' + Math.abs(hash).toString(36);
    localStorage.setItem(DEVICE_ID_KEY, deviceId);
    console.log("ðŸ†” Novo ID de dispositivo gerado (persistente):", deviceId);
  } else {
    console.log("ðŸ†” Device ID existente (persistente):", deviceId);
  }
  
  return deviceId;
}

function isMissingRelationError(error) {
  return !!(error?.message && error.message.includes("relation") && error.message.includes("does not exist"));
}

function isMissingColumnError(error, columnName) {
  return !!(error?.message && error.message.includes("column") && error.message.includes("does not exist") && (!columnName || error.message.includes(columnName)));
}

function getDispositivoHeartbeatMs(registro) {
  const referencia = registro?.last_seen || registro?.updated_at || registro?.created_at;
  if (!referencia) return Infinity;
  const ts = new Date(referencia).getTime();
  if (!Number.isFinite(ts)) return Infinity;
  return Date.now() - ts;
}

function isDispositivoRegistroRecente(registro) {
  return getDispositivoHeartbeatMs(registro) <= DISPOSITIVO_STALE_MS;
}

async function listarDispositivosAtivosPorCodigo(codigo) {
  let query = client
    .from("dispositivos")
    .select("id, device_id, local_nome, is_ativo, last_seen, updated_at, created_at")
    .eq("codigo_display", codigo)
    .eq("is_ativo", true);

  let { data, error } = await query;

  if (error && isMissingColumnError(error, "last_seen")) {
    const fallback = await client
      .from("dispositivos")
      .select("id, device_id, local_nome, is_ativo, updated_at, created_at")
      .eq("codigo_display", codigo)
      .eq("is_ativo", true);
    data = fallback.data;
    error = fallback.error;
  }

  const registros = Array.isArray(data) ? data.slice() : [];
  registros.sort((a, b) => getDispositivoHeartbeatMs(a) - getDispositivoHeartbeatMs(b));
  return { data: registros, error };
}

async function desativarDispositivosStale(codigo, deviceIdAtual, registros) {
  const base = Array.isArray(registros) ? registros : [];
  const staleIds = base
    .filter((registro) => registro?.id)
    .filter((registro) => registro.device_id !== deviceIdAtual)
    .filter((registro) => !isDispositivoRegistroRecente(registro))
    .map((registro) => registro.id);

  if (!staleIds.length) return;

  console.log("🧹 Liberando vínculos antigos para o código:", codigo, staleIds);
  await client
    .from("dispositivos")
    .update({ is_ativo: false })
    .in("id", staleIds);
}

async function obterCodigoEmUsoPorOutroDispositivo(codigo, deviceIdAtual) {
  const { data: registros, error } = await listarDispositivosAtivosPorCodigo(codigo);
  if (error) {
    return { codigoEmUso: null, error };
  }

  await desativarDispositivosStale(codigo, deviceIdAtual, registros);

  const codigoEmUso = registros.find((registro) =>
    registro?.device_id &&
    registro.device_id !== deviceIdAtual &&
    isDispositivoRegistroRecente(registro)
  ) || null;

  return { codigoEmUso, error: null };
}

// Garantir que elementos estejam visÃ­veis quando a pÃ¡gina carregar
// Reconecta canais realtime quando app volta do background (critico no Android)
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && codigoAtual && realtimeReady) {
    console.log('[realtime] app voltou ao foreground, reconectando canais...');
    iniciarRealtime();
  }
});

document.addEventListener('DOMContentLoaded', function() {
  ensureElementsVisible();
  
  // Verificar localStorage PRIMEIRO (busca rÃ¡pida)
  const codigoLocal = localStorage.getItem(CODIGO_DISPLAY_KEY);
  const localLocal = localStorage.getItem(LOCAL_TELA_KEY);
  
  // Se hÃ¡ cÃ³digo salvo, esconder tela de login IMEDIATAMENTE e FORÃ‡AR fullscreen
  if (codigoLocal && codigoLocal.trim() && localLocal && localLocal.trim()) {
    console.log("ðŸ”’ CÃ³digo salvo detectado no carregamento - Escondendo login e FORÃ‡ANDO fullscreen");
    
    // Esconder elementos de login IMEDIATAMENTE (sem delay para nÃ£o aparecer brevemente)
    const inputDiv = document.getElementById("codigoInput");
    const rodape = document.getElementById("rodape");
    const logo = document.getElementById("logo");
    if (inputDiv) {
      inputDiv.style.display = "none";
      inputDiv.style.opacity = "0";
      inputDiv.style.visibility = "hidden";
    }
    if (rodape) {
      rodape.style.display = "none";
      rodape.style.opacity = "0";
      rodape.style.visibility = "hidden";
    }
    if (logo) {
      logo.style.display = "none";
      logo.style.opacity = "0";
      logo.style.visibility = "hidden";
    }
    
    // Tentar fullscreen imediatamente
    setTimeout(() => {
      entrarFullscreen();
    }, 100);
    setTimeout(() => {
      entrarFullscreen();
    }, 400);
    setTimeout(() => {
      entrarFullscreen();
    }, 800);
  }
  
  // Tentar entrar em fullscreen imediatamente se for PWA instalado
  if (window.matchMedia('(display-mode: standalone)').matches || 
      window.navigator.standalone === true ||
      document.referrer.includes('android-app://')) {
    // Ã‰ um PWA instalado, tentar fullscreen imediatamente
    setTimeout(() => entrarFullscreen(), 100);
  }
  
  // Verificar se jÃ¡ existe um cÃ³digo salvo e iniciar automaticamente
  verificarCodigoSalvo();
  
  // Listener para mudanÃ§as no fullscreen - usar novo sistema de monitoramento
  const verificarFullscreenEreativar = () => {
    const codigoSalvo = localStorage.getItem(CODIGO_DISPLAY_KEY);
    const localSalvo = localStorage.getItem(LOCAL_TELA_KEY);
    const temCodigoCompleto = codigoSalvo && codigoSalvo.trim() && localSalvo && localSalvo.trim();
    
    // SÃ³ tentar reativar se tiver cÃ³digo salvo E o player estiver ativo
    if (temCodigoCompleto && isPlayerAtivo()) {
      if (!isFullscreen()) {
        // Tentar reativar imediatamente
        entrarFullscreen();
      }
    } else {
      // Se nÃ£o tem cÃ³digo ou player nÃ£o estÃ¡ ativo, parar monitoramento
      stopFullscreenMonitoring();
    }
  };
  
  // Listener para mudanÃ§as no fullscreen (padrÃ£o)
  document.addEventListener('fullscreenchange', verificarFullscreenEreativar);
  
  // Listener para mudanÃ§as no fullscreen (WebKit - Chrome/Safari)
  document.addEventListener('webkitfullscreenchange', verificarFullscreenEreativar);
  
  // Listener para mudanÃ§as no fullscreen (Mozilla)
  document.addEventListener('mozfullscreenchange', verificarFullscreenEreativar);
  
  // Listener para mudanÃ§as no fullscreen (IE/Edge)
  document.addEventListener('MSFullscreenChange', verificarFullscreenEreativar);
  
  // Listener para quando a pÃ¡gina ganha foco (ao voltar para a aba)
  window.addEventListener('focus', () => {
    const codigoSalvo = localStorage.getItem(CODIGO_DISPLAY_KEY);
    const localSalvo = localStorage.getItem(LOCAL_TELA_KEY);
    const temCodigoCompleto = codigoSalvo && codigoSalvo.trim() && localSalvo && localSalvo.trim();
    
    if (temCodigoCompleto && isPlayerAtivo()) {
      setTimeout(() => entrarFullscreen(), 100);
    }
  });
  
  // Listener para quando a pÃ¡gina fica visÃ­vel (ao voltar do background)
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) {
      const codigoSalvo = localStorage.getItem(CODIGO_DISPLAY_KEY);
      const localSalvo = localStorage.getItem(LOCAL_TELA_KEY);
      const temCodigoCompleto = codigoSalvo && codigoSalvo.trim() && localSalvo && localSalvo.trim();
      
      if (temCodigoCompleto && isPlayerAtivo()) {
        setTimeout(() => entrarFullscreen(), 100);
      }
    }
  });
});

// ===== Sistema de NotificaÃ§Ãµes =====
function showNotification(message, type = 'error') {
  // Remove notificaÃ§Ã£o existente se houver
  const existingNotification = document.getElementById('notification');
  if (existingNotification) {
    existingNotification.remove();
  }

  // Cria elemento da notificaÃ§Ã£o
  const notification = document.createElement('div');
  notification.id = 'notification';
  notification.textContent = message;
  
  // Estilos da notificaÃ§Ã£o
  notification.style.cssText = `
    position: fixed;
    top: 20px;
    right: 20px;
    background: ${type === 'error' ? '#EF4444' : '#10B981'};
    color: white;
    padding: 16px 24px;
    border-radius: 8px;
    font-size: 16px;
    font-weight: 500;
    box-shadow: 0 10px 25px rgba(0, 0, 0, 0.3);
    z-index: 10000;
    max-width: 400px;
    word-wrap: break-word;
    opacity: 0;
    transform: translateX(100%);
    transition: all 0.3s ease;
  `;

  // Adiciona ao DOM
  document.body.appendChild(notification);

  // Anima entrada
  setTimeout(() => {
    notification.style.opacity = '1';
    notification.style.transform = 'translateX(0)';
  }, 10);

  // Remove apÃ³s 4 segundos
  setTimeout(() => {
    notification.style.opacity = '0';
    notification.style.transform = 'translateX(100%)';
    setTimeout(() => {
      if (notification.parentNode) {
        notification.remove();
      }
    }, 300);
  }, 4000);
}

// ===== FunÃ§Ã£o para limpar campo de cÃ³digo =====
function clearCodeField() {
  const codigoField = document.getElementById("codigoTela");
  if (codigoField) {
    codigoField.value = '';
    codigoField.focus();
  }
}

// ===== FunÃ§Ã£o para limpar cÃ³digo salvo =====
function limparCodigoSalvo() {
  localStorage.removeItem(CODIGO_DISPLAY_KEY);
  console.log("ðŸ—‘ï¸ CÃ³digo salvo removido do localStorage");
  const codigoField = document.getElementById("codigoTela");
  if (codigoField) {
    codigoField.value = '';
    codigoField.focus();
  }
}

// ===== FunÃ§Ã£o para garantir que elementos estejam visÃ­veis =====
function ensureElementsVisible() {
  const codigoInput = document.getElementById("codigoInput");
  const rodape = document.getElementById("rodape");
  const logo = document.getElementById("logo");
  
  if (codigoInput) {
    codigoInput.style.display = "flex";
    codigoInput.classList.remove("fade-out");
  }
  if (rodape) {
    rodape.style.display = "block";
    rodape.classList.remove("fade-out");
  }
  if (logo) {
    logo.style.display = "block";
    logo.classList.remove("fade-out");
  }
}

// ===== HLS handle =====
let hls = null;
function destroyHls() {
  if (hls) {
    try { hls.destroy(); } catch {}
    hls = null;
  }
}

// ===== IndexedDB Helpers (para MP4 IDB flow) =====
function idbOpen() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open("mrit-player-idb", 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("videos")) db.createObjectStore("videos");
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbSet(key, blob) {
  const db = await idbOpen();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("videos", "readwrite");
    const store = tx.objectStore("videos");
    const r = store.put(blob, key);
    r.onsuccess = () => resolve(true);
    r.onerror = () => reject(r.error);
  });
}

async function idbGet(key) {
  const db = await idbOpen();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("videos", "readonly");
    const store = tx.objectStore("videos");
    const r = store.get(key);
    r.onsuccess = () => resolve(r.result || null);
    r.onerror = () => reject(r.error);
  });
}

async function idbDel(key) {
  const db = await idbOpen();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("videos", "readwrite");
    const store = tx.objectStore("videos");
    const r = store.delete(key);
    r.onsuccess = () => resolve(true);
    r.onerror = () => reject(r.error);
  });
}

async function idbAllKeys() {
  const db = await idbOpen();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("videos", "readonly");
    const store = tx.objectStore("videos");
    const r = store.getAllKeys();
    r.onsuccess = () => resolve(r.result || []);
    r.onerror = () => reject(r.error);
  });
}

function trackObjectUrl(url) {
  if (url && typeof url === "string" && url.startsWith("blob:")) {
    activeObjectUrls.add(url);
  }
  return url;
}

function revokeTrackedObjectUrl(url) {
  if (!url || !activeObjectUrls.has(url)) return;
  try {
    URL.revokeObjectURL(url);
  } catch {}
  activeObjectUrls.delete(url);
}

function revokeElementObjectUrl(el) {
  if (!el) return;
  const objectUrl = el.dataset?.mritObjectUrl;
  if (!objectUrl) return;
  revokeTrackedObjectUrl(objectUrl);
  delete el.dataset.mritObjectUrl;
}

function setMediaElementSource(el, src) {
  if (!el) return;
  revokeElementObjectUrl(el);
  el.src = src;
  if (typeof src === "string" && src.startsWith("blob:")) {
    el.dataset.mritObjectUrl = src;
    trackObjectUrl(src);
  }
}

function buildCacheLookupCandidates(url) {
  if (!url) return [];
  const candidates = [String(url)];
  try {
    const parsed = new URL(url);
    const withoutQuery = `${parsed.origin}${parsed.pathname}`;
    if (withoutQuery !== url) candidates.push(withoutQuery);
  } catch {}
  return [...new Set(candidates)];
}

async function findCachedVideoBlobLocal(url) {
  const candidates = buildCacheLookupCandidates(url);
  if (!candidates.length) return null;

  for (const candidate of candidates) {
    const exactBlob = await idbGet(`${codigoAtual}::${candidate}`);
    if (exactBlob && exactBlob.size > 0) return exactBlob;
  }

  const keys = await idbAllKeys();
  for (const rawKey of keys) {
    const key = String(rawKey);
    if (!candidates.some((candidate) => key.endsWith(`::${candidate}`))) continue;
    const blob = await idbGet(key);
    if (blob && blob.size > 0) return blob;
  }

  return null;
}

async function findCachedImageBlobLocal(url) {
  const candidates = buildCacheLookupCandidates(url);
  if (!candidates.length) return null;

  const cache = await caches.open("mrit-player-cache-v13");
  for (const candidate of candidates) {
    const cachedResponse = await cache.match(candidate);
    if (!cachedResponse || !cachedResponse.ok) continue;
    const blob = await cachedResponse.blob();
    if (blob && blob.size > 0) return blob;
  }

  return null;
}

async function getPlayableCachedSource(url, mediaType) {
  if (!codigoAtual || !url) return null;

  try {
    const blob = mediaType === "video"
      ? await findCachedVideoBlobLocal(url)
      : await findCachedImageBlobLocal(url);

    if (!blob || blob.size <= 0) return null;
    return trackObjectUrl(URL.createObjectURL(blob));
  } catch (err) {
    console.warn("⚠️ Erro ao montar source local do cache:", mediaType, url, err?.message || err);
    return null;
  }
}

// ===== Cache helpers (namespaced por cÃ³digo) =====
function cacheKeyFor(codigo) {
  return `playlist_cache_${codigo}`;
}

function hasSavedPlaylistCache(codigo) {
  if (!codigo) return false;
  try {
    const raw = localStorage.getItem(cacheKeyFor(codigo));
    if (!raw) return false;
    const data = JSON.parse(raw);
    return Array.isArray(data?.playlist) && data.playlist.length > 0;
  } catch (err) {
    console.warn("Falha ao ler cache salvo da playlist:", codigo, err?.message || err);
    return false;
  }
}

function buildPlaylistSignature(items) {
  const list = Array.isArray(items) ? items : [];
  return list.map((item, index) => {
    const url = (item?.url || "").trim();
    const urlPortrait = (item?.urlPortrait || "").trim();
    const urlLandscape = (item?.urlLandscape || "").trim();
    const urlLow = (item?.urlLow || item?.url_low || "").trim();
    const urlPortraitLow = (item?.urlPortraitLow || item?.url_portrait_low || "").trim();
    const urlLandscapeLow = (item?.urlLandscapeLow || item?.url_landscape_low || "").trim();
    const tipo = (item?.tipo || "").toString().trim().toLowerCase();
    const duration = item?.duration ?? "";
    const fit = item?.fit ?? "";
    const focus = item?.focus ?? "";
    const feedQuery    = (item?.feed_query           ?? "").toString().trim();
    const feedSlides   = (item?.feed_slides          ?? "").toString().trim();
    const feedDuration = (item?.feed_slide_duration  ?? "").toString().trim();
    return `${index}::${url}::${urlPortrait}::${urlLandscape}::${urlLow}::${urlPortraitLow}::${urlLandscapeLow}::${tipo}::${duration}::${fit}::${focus}::${feedQuery}::${feedSlides}::${feedDuration}`;
  }).join("||");
}

// ===== AtualizaÃ§Ã£o de Status do Cache =====
async function atualizarStatusCache(codigo, status, completo = null) {
  if (!codigo || !navigator.onLine) return;
  try {
    const updates = { cache: status };
    if (completo !== null) {
      updates.cache_ready = completo;
      updates.cache_ready_at = completo ? new Date().toISOString() : null;
    }
    const { error } = await client.from('displays').update(updates).eq('codigo_unico', codigo);
    if (error) console.error('Erro ao atualizar status do cache:', error);
  } catch (err) {
    console.error('Erro na conexao ao atualizar cache:', err);
  }
}

// ===== VerificaÃ§Ã£o e ValidaÃ§Ã£o do Cache =====
async function verificarEAtualizarStatusCache() {
  if (!codigoAtual || !playlist || playlist.length === 0) {
    await atualizarStatusCache(codigoAtual, false);
    return false;
  }
  
  try {
    console.log("ðŸ” Verificando se cache estÃ¡ realmente pronto...");
    
    let videosEmCache = 0;
    let totalVideos = 0;
    let videosFaltando = [];
    let imagensEmCache = 0;
    let totalImagens = 0;
    let imagensFaltando = [];
    
    // Verificar cada item da playlist
    for (const item of playlist) {
      const url = pickSourceForOrientation(item);
      const isVideo = /\.(mp4|webm|mkv|mov|avi)(\?|$)/i.test(url);
      const isImage = /\.(jpg|jpeg|png|webp)(\?|$)/i.test(url);
      
      if (isVideo) {
        totalVideos++;
        const cacheKey = `${codigoAtual}::${url}`;
        const cachedBlob = await idbGet(cacheKey);
        
        if (cachedBlob && cachedBlob.size > 0) {
          videosEmCache++;
          console.log(`âœ… VÃ­deo em cache: ${url} (${cachedBlob.size} bytes)`);
        } else {
          videosFaltando.push(url);
          console.log(`âŒ VÃ­deo nÃ£o em cache: ${url}`);
        }
      } else if (isImage) {
        totalImagens++;
        // Verificar se imagem estÃ¡ no cache do Service Worker
        try {
          const cache = await caches.open("mrit-player-cache-v13");
          const cachedResponse = await cache.match(url);
          
          if (cachedResponse && cachedResponse.ok) {
            imagensEmCache++;
            console.log(`âœ… Imagem em cache: ${url}`);
          } else {
            imagensFaltando.push(url);
            console.log(`âŒ Imagem nÃ£o em cache: ${url}`);
          }
        } catch (error) {
          console.log(`âš ï¸ Erro ao verificar cache da imagem: ${url}`, error);
          imagensFaltando.push(url);
        }
      }
    }
    
    // Calcular percentual de cache
    const percentualVideos = totalVideos > 0 ? (videosEmCache / totalVideos) * 100 : 100;
    const percentualImagens = totalImagens > 0 ? (imagensEmCache / totalImagens) * 100 : 100;
    
    // Cache pronto se >= 80% (playback normal); completo se 100% (cache_ready)
    const cachePronto  = percentualVideos >= 80 || percentualImagens >= 80;
    const cacheCompleto = (totalVideos === 0 || videosEmCache === totalVideos) &&
                          (totalImagens === 0 || imagensEmCache === totalImagens);
    
    console.log(`ðŸ“Š Cache de VÃ­deos: ${videosEmCache}/${totalVideos} (${percentualVideos.toFixed(1)}%)`);
    console.log(`ðŸ“Š Cache de Imagens: ${imagensEmCache}/${totalImagens} (${percentualImagens.toFixed(1)}%)`);
    console.log(`ðŸ“Š Status: ${cachePronto ? 'âœ… Pronto' : 'âŒ NÃ£o pronto'}`);
    
    // Se hÃ¡ vÃ­deos faltando, forÃ§ar cache direto
    if (videosFaltando.length > 0) {
      console.log("ðŸ”„ VÃ­deos faltando no cache, forÃ§ando cache direto...");
      const resultado = await mritDebug.forcarCacheDireto();
      if (resultado && resultado.cachedCount > 0) {
        console.log("âœ… Cache direto concluÃ­do com sucesso");
        // Verificar novamente apÃ³s cache direto
        return await verificarEAtualizarStatusCache();
      }
    }
    
    // Se hÃ¡ imagens faltando, forÃ§ar cache de imagens
    if (imagensFaltando.length > 0) {
      console.log("ðŸ”„ Imagens faltando no cache, forÃ§ando cache de imagens...");
      await mritDebug.forcarCacheImagens();
    }
    
    // Atualizar status no banco
    await atualizarStatusCache(codigoAtual, cachePronto, cacheCompleto);
    
    return cachePronto;
  } catch (error) {
    console.error("âŒ Erro ao verificar cache:", error);
    await atualizarStatusCache(codigoAtual, false);
    return false;
  }
}

// ===== Orientation utils =====
let ORIENTATION = "landscape"; // orientacao de exibicao/conteudo
let PHYSICAL_ORIENTATION = "landscape";
let DISPLAY_ORIENTATION_SETTING = "auto";

function normalizeOrientationSetting(value) {
  const normalized = String(value || "auto").trim().toLowerCase();
  if (["portrait", "vertical", "retrato"].includes(normalized)) return "portrait";
  if (["landscape", "horizontal", "paisagem"].includes(normalized)) return "landscape";
  return "auto";
}

function detectOrientation() {
  const so = (screen.orientation && screen.orientation.type) || "";
  if (so.includes("portrait")) return "portrait";
  if (so.includes("landscape")) return "landscape";
  return (window.innerHeight > window.innerWidth) ? "portrait" : "landscape";
}
function applyOrientation(physical = detectOrientation()) {
  PHYSICAL_ORIENTATION = physical;
  ORIENTATION = DISPLAY_ORIENTATION_SETTING === "auto" ? physical : DISPLAY_ORIENTATION_SETTING;
  document.documentElement.dataset.orientation = ORIENTATION;
  document.documentElement.dataset.physicalOrientation = PHYSICAL_ORIENTATION;
  document.documentElement.dataset.orientationSetting = DISPLAY_ORIENTATION_SETTING;
  document.documentElement.dataset.rotateContent = ORIENTATION !== PHYSICAL_ORIENTATION ? "true" : "false";
  reapplyActiveMediaFit();
}
function applyDisplayOrientationSetting(value) {
  const nextSetting = normalizeOrientationSetting(value);
  const changed = nextSetting !== DISPLAY_ORIENTATION_SETTING;
  DISPLAY_ORIENTATION_SETTING = nextSetting;
  applyOrientation(PHYSICAL_ORIENTATION || detectOrientation());
  try {
    localStorage.setItem(DISPLAY_ORIENTATION_STORAGE_KEY, DISPLAY_ORIENTATION_SETTING);
  } catch {}
  if (changed) {
    console.log("Orientacao do display aplicada:", DISPLAY_ORIENTATION_SETTING);
  }
  return changed;
}
function setupOrientationWatcher() {
  try {
    DISPLAY_ORIENTATION_SETTING = normalizeOrientationSetting(localStorage.getItem(DISPLAY_ORIENTATION_STORAGE_KEY));
  } catch {
    DISPLAY_ORIENTATION_SETTING = "auto";
  }
  applyOrientation(detectOrientation());
  if (screen.orientation && screen.orientation.addEventListener) {
    screen.orientation.addEventListener("change", () => applyOrientation(detectOrientation()));
  }
  const mm = window.matchMedia("(orientation: portrait)");
  if (mm && mm.addEventListener) {
    mm.addEventListener("change", () => applyOrientation(detectOrientation()));
  }
  let rid = null;
  window.addEventListener("resize", () => {
    clearTimeout(rid);
    rid = setTimeout(() => applyOrientation(detectOrientation()), 150);
  });
}

// ===== Fit rules por orientaÃ§Ã£o/tipo =====
// Mesma orientacao preenche a tela; orientacao diferente preserva o quadro inteiro.
const FIT_RULES = {
  portrait:  { image: "cover", video: "cover" },
  landscape: { image: "cover", video: "cover" },
};
function applyFit(el, fit = "cover", pos = "center center") {
  el.style.objectFit = fit;
  el.style.objectPosition = pos;
}

function getOrientationFromDimensions(width, height) {
  const w = Number(width || 0);
  const h = Number(height || 0);
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return null;
  if (Math.abs(w - h) <= 1) return ORIENTATION;
  return h > w ? "portrait" : "landscape";
}

function getOrientationFromSelectedSource(item, selectedUrl) {
  const url = (selectedUrl || "").trim();
  if (!url) return null;

  const portraitUrls = [
    item?.urlPortrait, item?.url_portrait,
    item?.urlPortraitLow, item?.url_portrait_low,
    item?.urlPortraitMedium, item?.url_portrait_medium,
  ].map(value => (value || "").trim()).filter(Boolean);
  if (portraitUrls.includes(url)) return "portrait";

  const landscapeUrls = [
    item?.urlLandscape, item?.url_landscape,
    item?.urlLandscapeLow, item?.url_landscape_low,
    item?.urlLandscapeMedium, item?.url_landscape_medium,
  ].map(value => (value || "").trim()).filter(Boolean);
  if (landscapeUrls.includes(url)) return "landscape";

  return null;
}

function getSmartMediaFit(item, type, selectedUrl, mediaEl) {
  const fallback = FIT_RULES[ORIENTATION]?.[type] || "cover";
  const mediaOrientation =
    type === "video"
      ? getOrientationFromDimensions(mediaEl?.videoWidth, mediaEl?.videoHeight) || getOrientationFromSelectedSource(item, selectedUrl)
      : getOrientationFromDimensions(mediaEl?.naturalWidth, mediaEl?.naturalHeight) || getOrientationFromSelectedSource(item, selectedUrl);
  if (!mediaOrientation) return fallback;
  return mediaOrientation === ORIENTATION ? "cover" : "contain";
}

function getVisibleVideoEl() {
  return getUniqueVideoEls().find(v => v && v.style.display !== "none") || video;
}

function reapplyActiveMediaFit() {
  if (!activeMediaItem || !activeMediaType || !currentItemUrl) return;

  if (activeMediaType === "video") {
    const videoEl = getVisibleVideoEl();
    if (!videoEl) return;
    const fit = getSmartMediaFit(activeMediaItem, "video", currentItemUrl, videoEl);
    const focus = activeMediaItem.focus || "center center";
    applyFit(videoEl, fit, focus);
    return;
  }

  if (activeMediaType === "image" && img) {
    const fit = getSmartMediaFit(activeMediaItem, "image", currentItemUrl, img);
    const focus = activeMediaItem.focus || "center center";
    applyFit(img, fit, focus);
  }
}

// (Opcional) Se tiver urls especÃ­ficas por orientaÃ§Ã£o no item
function pickSourceForOrientation(item) {
  if ((item && item.tipo || '').toLowerCase() === 'feed') {
    var fq = (item.feed_query || 'futebol').replace(/\s+/g, '_');
    return 'feed:' + fq;
  }
  if (shouldPreferReducedMedia()) {
    const reducedSource = pickSourceForOrientationAndTier(item, "low");
    if (reducedSource) return reducedSource;
  }
  return pickSourceForOrientationAndTier(item, "default");
}

// ===== Player =====
function startPlayer() {
  iniciar();
}

// Garantir acesso global para handlers no index.html
window.startPlayer = startPlayer;

// ===== FunÃ§Ã£o para verificar cÃ³digo salvo =====
async function verificarCodigoSalvo() {
  try {
    const deviceId = gerarDeviceId();
    
    // PRIMEIRO: Verificar localStorage (busca rÃ¡pida local)
    const codigoLocal = localStorage.getItem(CODIGO_DISPLAY_KEY);
    const localLocal = localStorage.getItem(LOCAL_TELA_KEY);
    
    if (codigoLocal && codigoLocal.trim()) {
      console.log("ðŸ“¦ CÃ³digo encontrado no localStorage:", codigoLocal);
      
      // Preencher campo imediatamente (feedback visual rÃ¡pido)
      const codigoField = document.getElementById("codigoTela");
      if (codigoField) codigoField.value = codigoLocal.trim().toUpperCase();
      
      // Tentar fullscreen imediatamente se hÃ¡ cÃ³digo salvo
      setTimeout(() => entrarFullscreen(), 200);
      setTimeout(() => entrarFullscreen(), 800);
      setTimeout(() => entrarFullscreen(), 1500);
    }
    
    // SEGUNDO: Buscar na tabela dispositivos (banco - fonte de verdade)
    if (navigator.onLine) {
      try {
        const { data: dispositivo, error: dispositivoError } = await client
          .from("dispositivos")
          .select("codigo_display, local_nome, is_ativo")
          .eq("device_id", deviceId)
          .eq("is_ativo", true)
          .maybeSingle();
        
        if (dispositivo && !dispositivoError) {
          console.log("ðŸ“± Dispositivo encontrado na tabela:", dispositivo);
          
          const codigoDisplay = dispositivo.codigo_display;
          const localNome = dispositivo.local_nome;
          
          // Preencher campo de cÃ³digo
          const codigoField = document.getElementById("codigoTela");
          if (codigoField) codigoField.value = codigoDisplay.trim().toUpperCase();
          
          // Verificar se o display ainda existe e se is_locked permite uso
          let { data: display, error: displayError } = await client
            .from("displays")
            .select("codigo_unico,is_locked,orientacao")
            .eq("codigo_unico", codigoDisplay)
            .maybeSingle();
          if (displayError && displayError.message && displayError.message.includes('column') && displayError.message.includes('does not exist')) {
            const { data: displayBasico } = await client
              .from("displays")
              .select("codigo_unico,is_locked")
              .eq("codigo_unico", codigoDisplay)
              .maybeSingle();
            display = displayBasico;
            displayError = null;
          }
          
          if (display) {
            // VERIFICAR: Se o cÃ³digo nÃ£o estÃ¡ sendo usado por outro dispositivo
            const { codigoEmUso, error: codigoEmUsoError } = await obterCodigoEmUsoPorOutroDispositivo(codigoDisplay, deviceId);

            if (codigoEmUsoError) {
              throw codigoEmUsoError;
            }
            
            if (codigoEmUso && codigoEmUso.device_id !== deviceId) {
              // CÃ³digo estÃ¡ sendo usado por outro dispositivo
              console.log("âŒ CÃ³digo jÃ¡ em uso por outro dispositivo:", codigoEmUso.device_id, "em", codigoEmUso.local_nome);
              showNotification(`C\u00F3digo j\u00E1 est\u00E1 em uso em: ${codigoEmUso.local_nome || 'outro local'}. Uma tela s\u00F3 pode ser usada em um lugar por vez.`);
              
              // Limpar dispositivo (desativar)
              await client
                .from("dispositivos")
                .update({ is_ativo: false })
                .eq("device_id", deviceId);
              
              // Limpar localStorage
              localStorage.removeItem(CODIGO_DISPLAY_KEY);
              localStorage.removeItem(LOCAL_TELA_KEY);
              
              // Limpar campo de cÃ³digo
              const codigoField = document.getElementById("codigoTela");
              if (codigoField) codigoField.value = "";
              
              return;
            }
            
            // VERIFICAR: Se is_locked = false, significa que exibiÃ§Ã£o foi parada
            // Nesse caso, NÃƒO iniciar automaticamente e limpar tudo
            if (display.is_locked === false) {
              console.log("â¸ï¸ Display estÃ¡ desbloqueado (is_locked = false), exibiÃ§Ã£o foi parada");
              
              // Desativar dispositivo
              await client
                .from("dispositivos")
                .update({ is_ativo: false })
                .eq("device_id", deviceId);
              
              // Limpar localStorage
              localStorage.removeItem(CODIGO_DISPLAY_KEY);
              localStorage.removeItem(LOCAL_TELA_KEY);
              
              // Limpar campo de cÃ³digo
              const codigoField = document.getElementById("codigoTela");
              if (codigoField) codigoField.value = "";
              
              console.log("ðŸ§¹ Dispositivo desativado e dados limpos. Aguardando novo cÃ³digo e local.");
              return; // NÃƒO iniciar automaticamente
            }
            
            // IMPORTANTE: Se encontrou na tabela dispositivos, Ã© o mesmo dispositivo
            // Mesmo que a tabela displays esteja locked, permitir uso
            console.log("âœ… Dispositivo encontrado na tabela dispositivos - mesmo dispositivo, iniciando automaticamente...");
            
            // Atualizar last_seen e garantir lock
            try {
              // Atualizar displays com device_id para garantir consistÃªncia
              await client
                .from("displays")
                .update({ 
                  is_locked: true,
                  status: "Em uso",
                  device_id: deviceId,  // Garantir que device_id estÃ¡ correto
                  device_last_seen: new Date().toISOString()
                })
                .eq("codigo_unico", codigoDisplay);
              
              await client
                .from("dispositivos")
                .update({ 
                  last_seen: new Date().toISOString(),
                  is_ativo: true  // Garantir que estÃ¡ ativo
                })
                .eq("device_id", deviceId);
              
              console.log("âœ… Displays e dispositivos atualizados com device_id:", deviceId);
            } catch (updateErr) {
              // Se campos nÃ£o existirem, fazer update sem eles
              if (updateErr.message && updateErr.message.includes('column') && updateErr.message.includes('does not exist')) {
                try {
                  await client
                    .from("displays")
                    .update({ 
                      is_locked: true,
                      status: "Em uso"
                    })
                    .eq("codigo_unico", codigoDisplay);
                  
                  await client
                    .from("dispositivos")
                    .update({ 
                      is_ativo: true
                    })
                    .eq("device_id", deviceId);
                } catch (err2) {
                  console.warn("âš ï¸ Erro ao atualizar displays/dispositivos:", err2);
                }
              } else {
                console.warn("âš ï¸ Erro ao atualizar:", updateErr);
              }
            }
            
            // Salvar no localStorage (sincronizar com banco)
            localStorage.setItem(CODIGO_DISPLAY_KEY, codigoDisplay);
            if (localNome) localStorage.setItem(LOCAL_TELA_KEY, localNome);
            console.log("ðŸ’¾ CÃ³digo e local salvos no localStorage:", codigoDisplay, localNome);
            
            // Configurar namespace no Service Worker IMEDIATAMENTE para usar cache correto
            if ('serviceWorker' in navigator && navigator.serviceWorker.controller) {
              navigator.serviceWorker.controller.postMessage({
                action: "setNamespace",
                namespace: codigoDisplay
              });
              console.log("ðŸ“¦ Namespace configurado no Service Worker:", codigoDisplay);
            }
            
            // Esconder elementos de login IMEDIATAMENTE (sem delay para nÃ£o aparecer brevemente)
            const inputDiv = document.getElementById("codigoInput");
            const rodape = document.getElementById("rodape");
            const logo = document.getElementById("logo");
            if (inputDiv) {
              inputDiv.style.display = "none";
              inputDiv.style.opacity = "0";
              inputDiv.style.visibility = "hidden";
            }
            if (rodape) {
              rodape.style.display = "none";
              rodape.style.opacity = "0";
              rodape.style.visibility = "hidden";
            }
            if (logo) {
              logo.style.display = "none";
              logo.style.opacity = "0";
              logo.style.visibility = "hidden";
            }
            
            // FORÃ‡AR fullscreen IMEDIATAMENTE (cÃ³digo salvo = obrigatÃ³rio fullscreen)
            console.log("ðŸ”’ CÃ³digo e local salvos detectados - FORÃ‡ANDO fullscreen obrigatÃ³rio");
            
            // Tentar fullscreen imediatamente
            entrarFullscreen();
            
            // MÃºltiplas tentativas de fullscreen
            setTimeout(() => {
              entrarFullscreen();
            }, 100);
            setTimeout(() => {
              entrarFullscreen();
            }, 300);
            setTimeout(() => {
              entrarFullscreen();
            }, 600);
            
            // Iniciar automaticamente (apÃ³s garantir que elementos estÃ£o escondidos)
            setTimeout(() => {
              startPlayer();
            }, 500);
            
            // Continuar tentando fullscreen apÃ³s iniciar
            setTimeout(() => {
              if (isPlayerAtivo()) {
                entrarFullscreen();
              }
            }, 1000);
            setTimeout(() => {
              if (isPlayerAtivo()) {
                entrarFullscreen();
              }
            }, 2000);
            setTimeout(() => {
              if (isPlayerAtivo()) {
                entrarFullscreen();
              }
            }, 3500);
            setTimeout(() => {
              if (isPlayerAtivo()) {
                entrarFullscreen();
              }
            }, 5000);
            setTimeout(() => {
              if (isPlayerAtivo()) {
                entrarFullscreen();
              }
            }, 7000);
            return;
          } else {
            console.log("âŒ Display nÃ£o encontrado, limpar dispositivo");
            // Display nÃ£o existe mais, desativar dispositivo
            await client
              .from("dispositivos")
              .update({ is_ativo: false })
              .eq("device_id", deviceId);
          }
        }
      } catch (err) {
        // Se tabela nÃ£o existir ainda, usar mÃ©todo antigo
        if (err.message && err.message.includes('relation') && err.message.includes('does not exist')) {
          console.log("â„¹ï¸ Tabela dispositivos ainda nÃ£o criada, usando mÃ©todo antigo");
        } else {
          console.error("Erro ao buscar dispositivo:", err);
        }
      }
    }
    
    // FALLBACK: MÃ©todo antigo (localStorage) - retrocompatibilidade
    // Usar o cÃ³digo jÃ¡ lido do localStorage (se nÃ£o encontrou no banco)
    const codigoSalvo = codigoLocal || localStorage.getItem(CODIGO_DISPLAY_KEY);
    
    if (codigoSalvo && codigoSalvo.trim()) {
      console.log("ðŸ“± CÃ³digo salvo encontrado (localStorage fallback):", codigoSalvo);
      
      // Preencher o campo com o cÃ³digo salvo
      const codigoField = document.getElementById("codigoTela");
      if (codigoField) {
        codigoField.value = codigoSalvo.trim().toUpperCase();
      }
      
      // FORÃ‡AR fullscreen se hÃ¡ cÃ³digo salvo (obrigatÃ³rio)
      console.log("ðŸ”’ CÃ³digo salvo detectado - FORÃ‡ANDO fullscreen obrigatÃ³rio");
      
      // Tentar fullscreen imediatamente (mas sÃ³ se player estiver ativo depois)
      setTimeout(() => {
        if (isPlayerAtivo()) {
          entrarFullscreen();
        }
      }, 200);
      setTimeout(() => {
        if (isPlayerAtivo()) {
          entrarFullscreen();
        }
      }, 800);
      setTimeout(() => {
        if (isPlayerAtivo()) {
          entrarFullscreen();
        }
      }, 1500);
      
      // Verificar se o cÃ³digo ainda Ã© vÃ¡lido no banco
      if (navigator.onLine) {
        try {
          // Buscar cÃ³digo com device_id para verificar se Ã© o mesmo dispositivo
          let { data: tela, error } = await client
            .from("displays")
            .select("codigo_unico,is_locked,device_id")
            .eq("codigo_unico", codigoSalvo.trim().toUpperCase())
            .maybeSingle();
          
          // Se nÃ£o encontrou device_id na primeira query, tentar sem ele (retrocompatibilidade)
          if (error && error.message && error.message.includes('column') && error.message.includes('does not exist')) {
            const { data: telaBasica } = await client
              .from("displays")
              .select("codigo_unico,is_locked")
              .eq("codigo_unico", codigoSalvo.trim().toUpperCase())
              .maybeSingle();
            tela = telaBasica;
            error = null;
          }
          
          if (tela) {
            // PRIMEIRO: Verificar na tabela dispositivos se este device_id estÃ¡ usando este cÃ³digo
            // Isso Ã© mais confiÃ¡vel que a tabela displays para identificar o mesmo dispositivo
            let mesmoDispositivoNaTabelaDispositivos = false;
            try {
              const { data: dispositivoVerificacao } = await client
                .from("dispositivos")
                .select("device_id, codigo_display, is_ativo")
                .eq("device_id", deviceId)
                .eq("codigo_display", codigoSalvo.trim().toUpperCase())
                .eq("is_ativo", true)
                .maybeSingle();
              
              if (dispositivoVerificacao) {
                mesmoDispositivoNaTabelaDispositivos = true;
                console.log("âœ… Mesmo dispositivo confirmado na tabela dispositivos");
              }
            } catch (err) {
              // Se tabela nÃ£o existir, ignorar
              if (err.message && err.message.includes('relation') && err.message.includes('does not exist')) {
                // Tabela nÃ£o existe - ok
              } else {
                console.warn("âš ï¸ Erro ao verificar na tabela dispositivos:", err);
              }
            }
            
            // Verificar se Ã© o mesmo dispositivo (mesmo device_id na tabela displays)
            const mesmoDispositivo = tela.device_id && tela.device_id === deviceId;
            
            // Verificar se Ã© um restart (mesmo dispositivo reconectando apÃ³s restart)
            const isRestarting = sessionStorage.getItem(RESTARTING_KEY) === 'true';
            
            // Se encontrou na tabela dispositivos OU Ã© restart, assumir que Ã© o mesmo dispositivo
            if (mesmoDispositivoNaTabelaDispositivos || isRestarting) {
              console.log("ðŸ”„ Mesmo dispositivo confirmado", mesmoDispositivoNaTabelaDispositivos ? "(tabela dispositivos)" : "(restart)");
              if (isRestarting) {
                sessionStorage.removeItem(RESTARTING_KEY); // Limpar flag
              }
            }
            
            // Permitir se: nÃ£o estÃ¡ locked OU se estÃ¡ locked mas Ã© o mesmo dispositivo (em qualquer tabela) OU se Ã© restart
            const podeUsar = !tela.is_locked || mesmoDispositivo || mesmoDispositivoNaTabelaDispositivos || isRestarting;
            
            if (podeUsar) {
              console.log("âœ… CÃ³digo vÃ¡lido", mesmoDispositivo ? "(mesmo dispositivo - displays)" : mesmoDispositivoNaTabelaDispositivos ? "(mesmo dispositivo - dispositivos)" : isRestarting ? "(restart)" : "(nÃ£o estÃ¡ em uso)", "iniciando automaticamente...");
              
              // Atualizar device_id e last_seen (garantir que estÃ¡ correto apÃ³s restart)
              try {
                await client
                  .from("displays")
                  .update({ 
                    device_id: deviceId,  // Sempre atualizar para garantir que estÃ¡ correto
                    device_last_seen: new Date().toISOString(),
                    is_locked: true,  // Garantir que estÃ¡ locked
                    status: "Em uso"
                  })
                  .eq("codigo_unico", codigoSalvo.trim().toUpperCase());
                console.log("âœ… Display atualizado apÃ³s restart/reconexÃ£o");
              } catch (updateErr) {
                // Ignorar erros silenciosamente se campos nÃ£o existirem
                if (updateErr.message && updateErr.message.includes('column') && updateErr.message.includes('does not exist')) {
                  // Campo nÃ£o existe ainda - normal, ignorar
                } else {
                  console.warn("âš ï¸ Erro ao atualizar device_id:", updateErr);
                }
              }
              
              // Configurar namespace no Service Worker IMEDIATAMENTE para usar cache correto
              if ('serviceWorker' in navigator && navigator.serviceWorker.controller) {
                navigator.serviceWorker.controller.postMessage({
                  action: "setNamespace",
                  namespace: codigoSalvo.trim().toUpperCase()
                });
                console.log("ðŸ“¦ Namespace configurado no Service Worker:", codigoSalvo.trim().toUpperCase());
              }
              
              // Esconder elementos de login IMEDIATAMENTE (sem delay para nÃ£o aparecer brevemente)
              const inputDiv = document.getElementById("codigoInput");
              const rodape = document.getElementById("rodape");
              const logo = document.getElementById("logo");
              if (inputDiv) {
                inputDiv.style.display = "none";
                inputDiv.style.opacity = "0";
                inputDiv.style.visibility = "hidden";
              }
              if (rodape) {
                rodape.style.display = "none";
                rodape.style.opacity = "0";
                rodape.style.visibility = "hidden";
              }
              if (logo) {
                logo.style.display = "none";
                logo.style.opacity = "0";
                logo.style.visibility = "hidden";
              }
              
              // FORÃ‡AR fullscreen IMEDIATAMENTE (cÃ³digo salvo = obrigatÃ³rio fullscreen)
              console.log("ðŸ”’ CÃ³digo vÃ¡lido detectado - FORÃ‡ANDO fullscreen obrigatÃ³rio");
              
              // Tentar fullscreen imediatamente
              entrarFullscreen();
              
              // MÃºltiplas tentativas de fullscreen
              setTimeout(() => {
                entrarFullscreen();
              }, 100);
              setTimeout(() => {
                entrarFullscreen();
              }, 300);
              setTimeout(() => {
                entrarFullscreen();
              }, 600);
              
              // Iniciar automaticamente (apÃ³s garantir que elementos estÃ£o escondidos)
              setTimeout(() => {
                startPlayer();
              }, 500);
              
              // Continuar tentando fullscreen apÃ³s iniciar
              setTimeout(() => {
                if (isPlayerAtivo()) {
                  entrarFullscreen();
                }
              }, 1000);
              setTimeout(() => {
                if (isPlayerAtivo()) {
                  entrarFullscreen();
                }
              }, 2000);
              setTimeout(() => {
                if (isPlayerAtivo()) {
                  entrarFullscreen();
                }
              }, 3500);
              setTimeout(() => {
                if (isPlayerAtivo()) {
                  entrarFullscreen();
                }
              }, 5000);
              return;
            } else {
              // EstÃ¡ locked E nÃ£o Ã© o mesmo dispositivo
              console.log("âš ï¸ CÃ³digo estÃ¡ em uso por outro dispositivo");
              showNotification("C\u00F3digo em uso por outro dispositivo. Aguarde ou insira outro c\u00F3digo.");
              // Limpar cÃ³digo salvo se estiver em uso por outro dispositivo
              localStorage.removeItem(CODIGO_DISPLAY_KEY);
              if (codigoField) codigoField.value = "";
              return;
            }
          } else {
            if (hasSavedPlaylistCache(codigoSalvo)) {
              console.warn("Codigo salvo nao foi confirmado no banco, mas existe cache local. Iniciando em modo offline.");
              showNotification("Sem confirmacao do servidor. Iniciando com o cache salvo.", "warning");
              setTimeout(() => {
                startPlayer();
              }, 500);
              return;
            }

            console.log("âŒ CÃ³digo nÃ£o encontrado no banco, limpar salvamento");
            localStorage.removeItem(CODIGO_DISPLAY_KEY);
            if (codigoField) codigoField.value = "";
            showNotification("C\u00F3digo salvo n\u00E3o \u00E9 mais v\u00E1lido. Insira um novo c\u00F3digo.");
            return;
          }
        } catch (err) {
          console.error("Erro ao verificar cÃ³digo no banco:", err);
          if (hasSavedPlaylistCache(codigoSalvo)) {
            console.warn("Falha ao validar codigo no servidor. Usando cache salvo para iniciar.");
            showNotification("Sem conexao estavel. Iniciando com o cache salvo.", "warning");
            setTimeout(() => {
              startPlayer();
            }, 500);
            return;
          }

          // Em caso de erro, manter o cÃ³digo salvo mas nÃ£o iniciar automaticamente
          showNotification("Erro ao verificar c\u00F3digo. Verifique sua conex\u00E3o.");
        }
      } else {
        // Offline: usar cÃ³digo salvo mesmo sem verificaÃ§Ã£o
        console.log("ðŸ“´ Modo offline, usando cÃ³digo salvo");
        setTimeout(() => {
          startPlayer();
        }, 1000);
      }
    } else {
      console.log("ðŸ“ Nenhum cÃ³digo salvo encontrado, aguardando entrada do usuÃ¡rio");
    }
  } catch (err) {
    console.error("Erro ao verificar cÃ³digo salvo:", err);
  }
}

async function iniciar() {
  console.log('ðŸš€ iniciar() chamada');
  console.log('ðŸ“¡ Status online:', navigator.onLine);
  console.log('ðŸ”— Supabase client:', typeof client !== 'undefined' ? 'disponÃ­vel' : 'NÃƒO DISPONÃVEL');
  initializeAdaptivePlaybackMode();
  
  // Debug temporÃ¡rio: alert no APK para ver se funÃ§Ã£o estÃ¡ sendo chamada
  if (window.matchMedia('(display-mode: standalone)').matches || document.referrer.includes('android-app://')) {
    console.log('ðŸ“± Detectado APK/PWA - funÃ§Ã£o iniciar() foi chamada');
  }
  
  setupOrientationWatcher();

  const codigoField = document.getElementById("codigoTela");
  if (!codigoField) {
    console.error('âŒ Campo codigoTela nÃ£o encontrado!');
    alert('Erro: Campo de c\u00F3digo n\u00E3o encontrado. Recarregue a p\u00E1gina.');
    return;
  }
  
  const codigo = codigoField.value.trim().toUpperCase();
  const hasCachedPlaylist = hasSavedPlaylistCache(codigo);
  const savedLocalName = (localStorage.getItem(LOCAL_TELA_KEY) || codigo).trim() || codigo;
  let forceOfflineStartup = false;
  console.log('ðŸ“ CÃ³digo digitado:', codigo);
  
  if (!codigo) {
    console.warn('âš ï¸ CÃ³digo vazio');
    showNotification("Informe o c\u00F3digo do display!");
    ensureElementsVisible();
    return;
  }
  
  console.log('âœ… CÃ³digo vÃ¡lido, continuando...');
  
  // Buscar o nome do display na tabela displays
  let local = null;
  if (navigator.onLine) {
    try {
      const { data: display, error: displayError } = await client
        .from("displays")
        .select("codigo_unico, nome")
        .eq("codigo_unico", codigo)
        .maybeSingle();

      if (displayError) {
        console.error("âŒ Erro ao buscar display:", displayError);
        if (hasCachedPlaylist) {
          console.warn("Falha ao buscar display no servidor. Usando informacoes salvas do cache local.");
          local = savedLocalName;
          forceOfflineStartup = true;
        } else {
          showNotification("Erro ao buscar informa\u00E7\u00F5es do display. Tente novamente.");
          ensureElementsVisible();
          return;
        }
      }

      if (!display && !forceOfflineStartup) {
        if (hasCachedPlaylist) {
          console.warn("Display nao confirmado no servidor. Seguindo com cache salvo.");
          local = savedLocalName;
          forceOfflineStartup = true;
        } else {
          showNotification("\u274C C\u00F3digo do display n\u00E3o encontrado!");
          ensureElementsVisible();
          return;
        }
      }

      if (!forceOfflineStartup) {
        local = display.nome || codigo; // Usa o nome do display, ou o cÃ³digo como fallback
        console.log("âœ… Display encontrado:", display.nome);
      }
    } catch (err) {
      console.error("âŒ Erro ao buscar display:", err);
      if (hasCachedPlaylist) {
        console.warn("Falha na consulta do display. Iniciando com cache local.");
        local = savedLocalName;
        forceOfflineStartup = true;
      } else {
        showNotification("Erro ao buscar informa\u00E7\u00F5es do display. Tente novamente.");
        ensureElementsVisible();
        return;
      }
    }
  } else {
    // Se offline, usa o cÃ³digo como fallback
    local = savedLocalName;
    forceOfflineStartup = hasCachedPlaylist;
  }
  
  // NÃƒO definir codigoAtual ainda - sÃ³ depois de validar
  
  // VALIDAÃ‡ÃƒO PRIMEIRO: Verificar se cÃ³digo jÃ¡ estÃ¡ em uso ANTES de fazer qualquer coisa
  if (navigator.onLine && !forceOfflineStartup) {
    try {
      const deviceId = gerarDeviceId();
      console.log("ðŸ” Device ID:", deviceId);
      console.log("ðŸ”— Verificando se cÃ³digo jÃ¡ estÃ¡ em uso...");
      
      // VERIFICAR PRIMEIRO: Se o cÃ³digo jÃ¡ estÃ¡ sendo usado por outro dispositivo
      const { codigoEmUso, error: checkError } = await obterCodigoEmUsoPorOutroDispositivo(codigo, deviceId);
      
      console.log("ðŸ“Š Resultado da verificaÃ§Ã£o:", codigoEmUso);
      
      if (checkError) {
        // Se tabela nÃ£o existir, ignorar (retrocompatibilidade)
        if (checkError.message && checkError.message.includes('relation') && checkError.message.includes('does not exist')) {
          console.log("â„¹ï¸ Tabela dispositivos ainda nÃ£o criada (opcional)");
        } else {
          console.error("âŒ Erro ao verificar cÃ³digo:", checkError);
          showNotification("Erro ao verificar c\u00F3digo. Tente novamente.");
          clearCodeField();
          ensureElementsVisible();
          return;
        }
      } else if (codigoEmUso) {
        // Verificar se Ã© o mesmo dispositivo
        if (codigoEmUso.device_id !== deviceId) {
          // CÃ³digo jÃ¡ estÃ¡ sendo usado por OUTRO dispositivo
          console.error("âŒ BLOQUEADO: CÃ³digo jÃ¡ em uso por outro dispositivo");
          console.log("   Device ID atual:", deviceId);
          console.log("   Device ID em uso:", codigoEmUso.device_id);
          console.log("   Local em uso:", codigoEmUso.local_nome);
          showNotification(`\u274C C\u00F3digo j\u00E1 est\u00E1 em uso em: ${codigoEmUso.local_nome || 'outro local'}. Uma tela s\u00F3 pode ser usada em um lugar por vez.`);
          clearCodeField();
          ensureElementsVisible();
          return; // BLOQUEAR - nÃ£o continua
        } else {
          console.log("âœ… Mesmo dispositivo, permitindo continuar");
        }
      } else {
        console.log("âœ… CÃ³digo livre, pode usar");
      }
    } catch (err) {
      console.error("âŒ Erro na validaÃ§Ã£o:", err);
      showNotification("Erro ao validar c\u00F3digo. Tente novamente.");
      clearCodeField();
      ensureElementsVisible();
      return;
    }
  }
  
  // Se chegou aqui, cÃ³digo estÃ¡ livre ou Ã© o mesmo dispositivo - pode continuar
  
  // IMPORTANTE: Se estava usando outro cÃ³digo, limpar o cÃ³digo antigo ANTES de salvar o novo
  const codigoAnterior = codigoAtual;
  if (codigoAnterior && codigoAnterior !== codigo) {
    console.log("ðŸ”„ Troca de cÃ³digo detectada:", codigoAnterior, "â†’", codigo);
    console.log("ðŸ—‘ï¸ Limpando cÃ³digo anterior do localStorage...");
    
    // Limpar localStorage do cÃ³digo anterior
    localStorage.removeItem(CODIGO_DISPLAY_KEY);
    localStorage.removeItem(LOCAL_TELA_KEY);
    
    // Limpar cache do namespace do cÃ³digo anterior
    if (navigator.serviceWorker?.controller) {
      navigator.serviceWorker.controller.postMessage({ action: "clearNamespace" });
    }
    
    // Desbloquear display anterior
    try {
      await client
        .from("displays")
        .update({ is_locked: false, status: "DisponÃ­vel" })
        .eq("codigo_unico", codigoAnterior);
      console.log("âœ… Display anterior desbloqueado:", codigoAnterior);
    } catch (err) {
      console.warn("âš ï¸ Erro ao desbloquear display anterior:", err);
    }
  }
  
  codigoAtual = codigo;
  awaitingServerRecovery = false;
  iniciarPollScreenshot();
  
  // Configurar namespace no Service Worker IMEDIATAMENTE para usar cache correto
  if ('serviceWorker' in navigator && navigator.serviceWorker.controller) {
    navigator.serviceWorker.controller.postMessage({
      action: "setNamespace",
      namespace: codigoAtual
    });
    console.log("ðŸ“¦ Namespace configurado no Service Worker:", codigoAtual);
  }
  
  // Salvar cÃ³digo e local no localStorage para uso futuro
  localStorage.setItem(CODIGO_DISPLAY_KEY, codigo);
  localStorage.setItem(LOCAL_TELA_KEY, local);
  console.log("ðŸ’¾ CÃ³digo e local salvos no localStorage:", codigo, local);
  
  // FORÃ‡AR fullscreen imediatamente apÃ³s salvar cÃ³digo
  console.log("ðŸ”’ CÃ³digo salvo - FORÃ‡ANDO fullscreen automÃ¡tico");
  entrarFullscreen();
  
  // MÃºltiplas tentativas agressivas de fullscreen
  setTimeout(() => entrarFullscreen(), 100);
  setTimeout(() => entrarFullscreen(), 300);
  setTimeout(() => entrarFullscreen(), 600);
  setTimeout(() => entrarFullscreen(), 1000);
  setTimeout(() => entrarFullscreen(), 2000);
  
  // Salvar na tabela dispositivos (nova tabela)
  if (navigator.onLine && !forceOfflineStartup) {
    try {
      const deviceId = gerarDeviceId();
      
      // Se chegou aqui, cÃ³digo estÃ¡ livre ou Ã© o mesmo dispositivo
      console.log("ðŸ”— Salvando dispositivo na tabela dispositivos...");
      
      // VERIFICAÃ‡ÃƒO DUPLA: Verificar novamente antes de salvar (evitar race condition)
        const { codigoEmUso: verificarDuplo, error: verificarDuploError } = await obterCodigoEmUsoPorOutroDispositivo(codigo, deviceId);

        if (verificarDuploError) {
          throw verificarDuploError;
        }
      
      if (verificarDuplo && verificarDuplo.device_id !== deviceId) {
        console.error("âŒ BLOQUEADO: CÃ³digo foi ocupado enquanto processava (race condition)");
        console.log("   Device ID atual:", deviceId);
        console.log("   Device ID que ocupou:", verificarDuplo.device_id);
          showNotification(`\u274C C\u00F3digo foi ocupado por outro dispositivo em: ${verificarDuplo.local_nome || 'outro local'}. Tente novamente.`);
        clearCodeField();
        ensureElementsVisible();
        return;
      }
      
      // Verificar se dispositivo jÃ¡ existe
      const { data: dispositivoExistente } = await client
        .from("dispositivos")
        .select("id, codigo_display")
        .eq("device_id", deviceId)
        .maybeSingle();
      
      if (dispositivoExistente) {
        // Se dispositivo existente estava usando outro cÃ³digo, liberar o cÃ³digo antigo
        if (dispositivoExistente.codigo_display && dispositivoExistente.codigo_display !== codigo) {
          console.log("ðŸ”„ Dispositivo estava usando outro cÃ³digo, liberando:", dispositivoExistente.codigo_display);
          
          // Desativar o uso do cÃ³digo antigo por este dispositivo
          await client
            .from("dispositivos")
            .update({ is_ativo: false })
            .eq("device_id", deviceId)
            .eq("codigo_display", dispositivoExistente.codigo_display);
        }
        
        // Atualizar dispositivo existente com NOVO cÃ³digo
        const { error: updateError } = await client
          .from("dispositivos")
          .update({
            codigo_display: codigo,
            local_nome: local,
            last_seen: new Date().toISOString(),
            is_ativo: true
          })
          .eq("device_id", deviceId);
        
        if (updateError) {
          console.error("âŒ Erro ao atualizar dispositivo:", updateError);
          showNotification("Erro ao atualizar dispositivo. Tente novamente.");
          clearCodeField();
          ensureElementsVisible();
          return;
        } else {
          console.log("âœ… Dispositivo atualizado na tabela");
        }
      } else {
        // Criar novo dispositivo - mas verificar novamente antes de inserir (race condition)
        const { codigoEmUso: verificarNovamente, error: verificarNovamenteError } = await obterCodigoEmUsoPorOutroDispositivo(codigo, deviceId);

        if (verificarNovamenteError) {
          throw verificarNovamenteError;
        }
        
        if (verificarNovamente && verificarNovamente.device_id !== deviceId) {
          console.error("âŒ BLOQUEADO: CÃ³digo foi ocupado enquanto processava (race condition)");
          console.log("   Device ID atual:", deviceId);
          console.log("   Device ID que ocupou:", verificarNovamente.device_id);
          showNotification(`\u274C C\u00F3digo foi ocupado por outro dispositivo em: ${verificarNovamente.local_nome || 'outro local'}. Tente novamente.`);
          clearCodeField();
          ensureElementsVisible();
          return;
        }
        
        // Criar novo dispositivo
        const { error: insertError } = await client
          .from("dispositivos")
          .insert({
            device_id: deviceId,
            codigo_display: codigo,
            local_nome: local,
            is_ativo: true
          });
        
        if (insertError) {
          // Se tabela nÃ£o existir, ignorar (retrocompatibilidade)
          if (insertError.message && insertError.message.includes('relation') && insertError.message.includes('does not exist')) {
            console.log("â„¹ï¸ Tabela dispositivos ainda nÃ£o criada (opcional)");
          } else {
            console.error("âŒ Erro ao criar dispositivo:", insertError);
            showNotification("Erro ao criar dispositivo. Tente novamente.");
            clearCodeField();
            ensureElementsVisible();
            return;
          }
        } else {
          console.log("âœ… Dispositivo criado na tabela");
          
          // VERIFICAÃ‡ÃƒO FINAL: Confirmar que realmente salvou e nÃ£o hÃ¡ conflito
          const { codigoEmUso: confirmacao, error: confirmacaoError } = await obterCodigoEmUsoPorOutroDispositivo(codigo, deviceId);

          if (confirmacaoError) {
            throw confirmacaoError;
          }
          
          if (confirmacao && confirmacao.device_id !== deviceId) {
            console.error("âŒ CONFLITO DETECTADO: Outro dispositivo ocupou o cÃ³digo apÃ³s salvar");
            // Remover este dispositivo
            await client
              .from("dispositivos")
              .update({ is_ativo: false })
              .eq("device_id", deviceId);
            
            showNotification("\u274C C\u00F3digo foi ocupado por outro dispositivo. Tente novamente.");
            clearCodeField();
            ensureElementsVisible();
            return;
          }
        }
      }
    } catch (err) {
      // Se tabela nÃ£o existir, ignorar (retrocompatibilidade)
      if (err.message && err.message.includes('relation') && err.message.includes('does not exist')) {
        console.log("â„¹ï¸ Tabela dispositivos ainda nÃ£o criada (opcional)");
      } else {
        console.error("âŒ Erro ao salvar dispositivo:", err);
        showNotification("Erro ao salvar dispositivo. Tente novamente.");
        clearCodeField();
        ensureElementsVisible();
        return;
      }
    }
    
    // TambÃ©m atualizar displays (mÃ©todo antigo - retrocompatibilidade)
    // IMPORTANTE: NÃƒO atualizar device_id aqui - ele Ã© Ãºnico por dispositivo fÃ­sico e nÃ£o muda quando troca de cÃ³digo
    // O device_id na tabela displays Ã© apenas informativo e nÃ£o deve ser atualizado ao trocar de cÃ³digo
    try {
      try {
        const { error } = await client
          .from("displays")
          .update({ 
            device_last_seen: new Date().toISOString()
            // device_id NÃƒO Ã© atualizado aqui - ele Ã© Ãºnico por dispositivo fÃ­sico
          })
          .eq("codigo_unico", codigo);
        
        if (error) {
          if (error.message && error.message.includes('column') && error.message.includes('does not exist')) {
            // Campos nÃ£o existem - ok
          } else {
            console.warn("âš ï¸ Erro ao atualizar displays:", error);
          }
        }
      } catch (updateErr) {
        if (updateErr.message && updateErr.message.includes('column') && updateErr.message.includes('does not exist')) {
          // Campos nÃ£o existem - ok
        } else {
          console.warn("âš ï¸ Erro ao atualizar displays:", updateErr);
        }
      }
    } catch (err) {
      // Ignorar
    }
  }

  // Reset agressivo ao trocar de cÃ³digo (garante que nada da sessÃ£o anterior vaze)
  if (codigoAnterior && codigoAnterior !== codigo) {
    await resetAllCachesForNewCode();
  }

  if (!navigator.onLine || forceOfflineStartup) {
    const cache = localStorage.getItem(cacheKeyFor(codigo));
    if (cache) {
      awaitingServerRecovery = !!forceOfflineStartup;
      const data = JSON.parse(cache);
      playlist = data.playlist;
      currentPlaylistId = data.codigo;
      currentContentCode = codigo;
      
      // Configurar namespace no Service Worker para usar cache correto
      if ('serviceWorker' in navigator && navigator.serviceWorker.controller) {
        navigator.serviceWorker.controller.postMessage({
          action: "setNamespace",
          namespace: codigoAtual
        });
        console.log("ðŸ“¦ Namespace configurado no Service Worker (offline):", codigoAtual);
      }

      // Configurar realtime se for playlist
      if (currentPlaylistId) {
        subscribePlaylistChannel(currentPlaylistId);
      } else {
        subscribePlaylistChannel(null);
      }

      setPlayerMode("playback");
      document.getElementById("codigoInput").style.display = "none";
      console.log("ðŸ“¦ Modo offline - usando cache da playlist:", playlist.length, "itens");
      tocarLoop();
      return;
    } else {
      showNotification("Sem internet e nenhum cache dispon\u00EDvel para esta tela.");
      clearCodeField();
      ensureElementsVisible();
      return;
    }
  }

  try {
    const deviceId = gerarDeviceId();
    
    // Buscar tela com device_id para verificar se Ã© o mesmo dispositivo
    let { data: tela, error } = await client
      .from("displays")
      .select("codigo_unico,is_locked,codigo_conteudoAtual,device_id,orientacao")
      .eq("codigo_unico", codigo)
      .maybeSingle();
    
    // Se nÃ£o encontrou device_id, tentar sem ele (retrocompatibilidade)
    if (error && error.message && error.message.includes('column') && error.message.includes('does not exist')) {
      const { data: telaBasica } = await client
        .from("displays")
        .select("codigo_unico,is_locked,codigo_conteudoAtual")
        .eq("codigo_unico", codigo)
        .maybeSingle();
      tela = telaBasica;
      error = null;
    }

    if (!tela) {
      showNotification("Tela n\u00E3o encontrada!");
      clearCodeField();
      ensureElementsVisible();
      return;
    }

    applyDisplayOrientationSetting(tela.orientacao);
    
    // Verificar se Ã© o mesmo dispositivo
    const mesmoDispositivo = tela.device_id && tela.device_id === deviceId;
    
    // Verificar se Ã© um restart (mesmo dispositivo reconectando)
    const isRestarting = sessionStorage.getItem(RESTARTING_KEY) === 'true';
    
    // Se Ã© restart e Ã© o mesmo dispositivo, permitir reconexÃ£o mesmo se locked
    if (isRestarting && mesmoDispositivo) {
      console.log("ðŸ”„ Restart detectado - mesmo dispositivo reconectando");
      sessionStorage.removeItem(RESTARTING_KEY); // Limpar flag
    }
    
    // Verificar se a tela estÃ¡ locked - se estiver E nÃ£o for o mesmo dispositivo, nÃ£o permitir
    if (tela.is_locked && !mesmoDispositivo && !isRestarting) {
      showNotification("Tela j\u00E1 em uso por outro dispositivo! Por favor, insira outro c\u00F3digo.");
      clearCodeField();
      ensureElementsVisible();
      return;
    }

    // Atualizar: lock e status
    // IMPORTANTE: device_id sÃ³ Ã© atualizado na primeira vez que o dispositivo usa um cÃ³digo
    // Se o device_id jÃ¡ existe e Ã© diferente, significa que outro dispositivo estÃ¡ usando
    // NÃ£o atualizamos device_id aqui para manter a integridade - ele Ã© Ãºnico por dispositivo fÃ­sico
    const updateData = { 
      is_locked: true, 
      status: "Em uso",
      device_last_seen: new Date().toISOString()
    };
    
    // SÃ³ atualizar device_id se ainda nÃ£o estiver definido (primeira vez) OU se for o mesmo dispositivo
    if (!tela.device_id) {
      updateData.device_id = deviceId;
      console.log("ðŸ†” Definindo device_id pela primeira vez para este cÃ³digo:", deviceId);
    } else if (tela.device_id === deviceId || (isRestarting && mesmoDispositivo)) {
      // Mesmo dispositivo - pode atualizar device_id para atualizar last_seen
      updateData.device_id = deviceId;
      if (isRestarting) {
        console.log("ðŸ”„ Atualizando device_id apÃ³s restart:", deviceId);
      }
    } else {
      // Device_id diferente - nÃ£o atualizar (outro dispositivo estÃ¡ usando)
      console.log("âš ï¸ Device_id diferente detectado - nÃ£o atualizando:", tela.device_id, "vs", deviceId);
    }
    
    try {
      await client
        .from("displays")
        .update(updateData)
        .eq("codigo_unico", tela.codigo_unico);
    } catch (updateErr) {
      // Se campos nÃ£o existirem, fazer update sem eles
      if (updateErr.message && updateErr.message.includes('column') && updateErr.message.includes('does not exist')) {
        await client
          .from("displays")
          .update({ is_locked: true, status: "Em uso" })
          .eq("codigo_unico", tela.codigo_unico);
      } else {
        throw updateErr;
      }
    }

    // FORÃ‡AR fullscreen apÃ³s validaÃ§Ã£o bem-sucedida (mÃºltiplas tentativas)
    entrarFullscreen();
    setTimeout(() => entrarFullscreen(), 200);
    setTimeout(() => entrarFullscreen(), 500);
    setTimeout(() => entrarFullscreen(), 1000);
    setTimeout(() => entrarFullscreen(), 2000);
    setTimeout(() => entrarFullscreen(), 3500);

    // Animar saÃ­da dos elementos da interface
    const inputDiv = document.getElementById("codigoInput");
    const rodape = document.getElementById("rodape");
    const logo = document.getElementById("logo");

    inputDiv.classList.add("fade-out");
    rodape.classList.add("fade-out");
    logo.classList.add("fade-out");

    setPlayerMode("playback");

    // informa o namespace (cÃ³digo da tela) ao service worker
    if ('serviceWorker' in navigator && navigator.serviceWorker.controller) {
      navigator.serviceWorker.controller.postMessage({
        action: "setNamespace",
        namespace: codigoAtual
      });
    }

    // Esconder elementos apÃ³s animaÃ§Ã£o
    setTimeout(() => {
      inputDiv.style.display = "none";
      rodape.style.display = "none";
      logo.style.display = "none";
    }, 500);

    await carregarConteudo(tela.codigo_conteudoAtual);

    if (!realtimeReady) {
      iniciarRealtime();
      realtimeReady = true;
    }

  // VerificaÃ§Ã£o periÃ³dica do cache (a cada 60 segundos)
  if (cacheCheckTimer) clearInterval(cacheCheckTimer);
  cacheCheckTimer = setInterval(async () => {
    if (codigoAtual && playlist && playlist.length > 0) {
      await verificarEAtualizarStatusCache();
    }
  }, 60000);

    // Verificar promoÃ§Ã£o apÃ³s carregar conteÃºdo
    await verificarPromocao();
  } catch (err) {
    console.error(err);
    showNotification("Erro na conex\u00E3o com o banco");
    clearCodeField();
    ensureElementsVisible();
  }
}

async function carregarConteudo(codigoConteudo) {
  try {
    // Resetar flag de primeiro ciclo ao carregar novo conteúdo
    isFirstCycle = true;
    
    const wasPlaying = !video.paused && video.style.display === "block";
    const currentTime = video.currentTime;
    const wasVideo = video.style.display === "block";
    const currentUrl = currentItemUrl;

    // ===== VERIFICAR CACHE PRIMEIRO =====
    // Se hÃ¡ cache salvo, carregar imediatamente para iniciar rÃ¡pido
    const cacheKeys = [];
    if (codigoConteudo) cacheKeys.push(cacheKeyFor(codigoConteudo));
    if (codigoAtual && codigoAtual !== codigoConteudo) cacheKeys.push(cacheKeyFor(codigoAtual));
    for (const cacheKey of cacheKeys) {
      const cacheSalvo = localStorage.getItem(cacheKey);
      if (!cacheSalvo) continue;
      try {
        const data = JSON.parse(cacheSalvo);
        if (data.playlist && Array.isArray(data.playlist) && data.playlist.length > 0) {
          console.log("ðŸ“¦ Cache encontrado! Carregando playlist do cache:", data.playlist.length, "itens");
          
          // Configurar namespace no Service Worker para usar o cache correto
          if ('serviceWorker' in navigator && navigator.serviceWorker.controller) {
            navigator.serviceWorker.controller.postMessage({
              action: "setNamespace",
              namespace: codigoAtual
            });
          }
          
          // Carregar playlist do cache imediatamente
          const cachedPlaylistId = data.codigo || null;
          playlist = data.playlist;
          currentPlaylistId = cachedPlaylistId;
          currentContentCode = codigoConteudo;
          
          // Se for playlist, configurar realtime
          if (cachedPlaylistId) {
            subscribePlaylistChannel(cachedPlaylistId);
          } else {
            subscribePlaylistChannel(null);
          }
          
          // Atualizar playlist com estado anterior (se houver)
          await atualizarPlaylist(playlist, cachedPlaylistId, {
            wasPlaying, currentTime, wasVideo, currentUrl
          });
          
          // Iniciar reproduÃ§Ã£o imediatamente do cache
          if (!isPlaying && !isLoadingVideo) {
            tocarLoop();
          }
          
          console.log("âœ… Playlist carregada do cache, iniciando reproduÃ§Ã£o imediatamente");
          
          // Verificar mudanÃ§as no banco em background (nÃ£o bloqueia)
          if (navigator.onLine) {
            console.log("ðŸ”„ Verificando mudanÃ§as na playlist em background...");
            verificarMudancasPlaylistEmBackground(codigoConteudo, cachedPlaylistId).catch(err => {
              console.warn("âš ï¸ Erro ao verificar mudanÃ§as em background:", err);
            });
          }
          
          return; // Retornar aqui - jÃ¡ carregou do cache
        }
      } catch (err) {
        console.warn("âš ï¸ Erro ao carregar cache salvo, buscando do banco:", err);
        // Continuar para buscar do banco
      }
    }

    // ===== BUSCAR DO BANCO (se nÃ£o hÃ¡ cache ou cache invÃ¡lido) =====
    // ConteÃºdo Ãºnico
    let { data: conteudo } = await client
      .from("conteudos")
      .select("*")
      .eq("codigoAnuncio", codigoConteudo)
      .maybeSingle();

    if (conteudo) {
      const conteudoUrl = conteudo.url || conteudo.urlPortrait || conteudo.urlLandscape || "";
      const isImageType = isImageItem(conteudo, conteudoUrl);

      const newPlaylist = [{
        url: conteudo.url,
        tipo: conteudo.tipo,
        duration: isImageType ? 0 : null, // imagem Ãºnica fica estÃ¡tica
        fit: conteudo.fit ?? null,
        focus: conteudo.focus ?? null,
        urlPortrait: conteudo.urlPortrait ?? null,
        urlLandscape: conteudo.urlLandscape ?? null,
      }];

      currentPlaylistId = null; // indica conteÃºdo Ãºnico
      currentContentCode = codigoConteudo;
      subscribePlaylistChannel(null);

      await atualizarPlaylist(newPlaylist, null, {
        wasPlaying, currentTime, wasVideo, currentUrl
      });
      return;
    }

    // Playlist
    let { data: playlistData } = await client
      .from("playlists")
      .select("*")
      .eq("codigo_unico", codigoConteudo)
      .maybeSingle();

    if (!playlistData) return;

    let { data: itens } = await client
      .from("playlist_itens")
      .select("*")
      .eq("playlist_id", codigoConteudo)
      .order("ordem", { ascending: true });

    processarForceRecache(itens);

    const newPlaylist = (itens || []).map(item => {
      const itemUrl = item.url || item.urlPortrait || item.urlLandscape || "";
      const isImageType = isImageItem(item, itemUrl);
      return {
        url: item.url,
        tipo: item.tipo || (isImageType ? "Imagem" : "VÃ­deo"),
        duration: isImageType ? 15000 : null,
        fit: item.fit ?? null,
        focus: item.focus ?? null,
        urlPortrait:          item.urlPortrait          ?? null,
        urlLandscape:         item.urlLandscape         ?? null,
        feed_query:           item.feed_query           ?? null,
        feed_slides:          item.feed_slides          ?? null,
        feed_slide_duration:  item.feed_slide_duration  ?? null,
        force_recache:        item.force_recache        ?? false,
      };
    });

    currentPlaylistId = codigoConteudo;
    currentContentCode = codigoConteudo;
    subscribePlaylistChannel(currentPlaylistId);

    await atualizarPlaylist(newPlaylist, codigoConteudo, {
      wasPlaying, currentTime, wasVideo, currentUrl
    });
  } catch (err) {
    console.error(err);
  }
}

// ===== Verificar mudanÃ§as na playlist em background =====
async function verificarMudancasPlaylistEmBackground(codigoConteudo, cachedPlaylistId) {
  try {
    // Verificar se Ã© conteÃºdo Ãºnico ou playlist
    let { data: conteudo } = await client
      .from("conteudos")
      .select("*")
      .eq("codigoAnuncio", codigoConteudo)
      .maybeSingle();

    if (conteudo) {
      // ConteÃºdo Ãºnico
      const conteudoUrl = conteudo.url || conteudo.urlPortrait || conteudo.urlLandscape || "";
      const isImageType = isImageItem(conteudo, conteudoUrl);

      const newPlaylist = [{
        url: conteudo.url,
        tipo: conteudo.tipo,
        duration: isImageType ? 0 : null,
        fit: conteudo.fit ?? null,
        focus: conteudo.focus ?? null,
        urlPortrait: conteudo.urlPortrait ?? null,
        urlLandscape: conteudo.urlLandscape ?? null,
      }];

      // Comparar com cache atual
      const cacheAtual = playlist || [];
      const mudou = JSON.stringify(cacheAtual) !== JSON.stringify(newPlaylist);
      
      if (mudou) {
        console.log("ðŸ”„ MudanÃ§a detectada no conteÃºdo Ãºnico, atualizando cache...");
        currentPlaylistId = null;
        currentContentCode = codigoConteudo;
        subscribePlaylistChannel(null);
        await atualizarPlaylist(newPlaylist, null, {});
      } else {
        console.log("âœ… ConteÃºdo Ãºnico nÃ£o mudou, mantendo cache");
      }
      return;
    }

    // Playlist
    let { data: playlistData } = await client
      .from("playlists")
      .select("*")
      .eq("codigo_unico", codigoConteudo)
      .maybeSingle();

    if (!playlistData) {
      console.warn("âš ï¸ Playlist nÃ£o encontrada no banco");
      return;
    }

    let { data: itens } = await client
      .from("playlist_itens")
      .select("*")
      .eq("playlist_id", codigoConteudo)
      .order("ordem", { ascending: true });

    processarForceRecache(itens);

    const newPlaylist = (itens || []).map(item => {
      const itemUrl = item.url || item.urlPortrait || item.urlLandscape || "";
      const isImageType = isImageItem(item, itemUrl);
      return {
        url: item.url,
        tipo: item.tipo || (isImageType ? "Imagem" : "VÃ­deo"),
        duration: isImageType ? 15000 : null,
        fit: item.fit ?? null,
        focus: item.focus ?? null,
        urlPortrait:          item.urlPortrait          ?? null,
        urlLandscape:         item.urlLandscape         ?? null,
        feed_query:           item.feed_query           ?? null,
        feed_slides:          item.feed_slides          ?? null,
        feed_slide_duration:  item.feed_slide_duration  ?? null,
        force_recache:        item.force_recache        ?? false,
      };
    });

    // Comparar com cache atual (respeitando a ordem dos itens)
    const cacheAtual = playlist || [];
    const assinaturaCache = buildPlaylistSignature(cacheAtual);
    const assinaturaNova = buildPlaylistSignature(newPlaylist);
    const mudou = assinaturaCache !== assinaturaNova;

    if (mudou) {
      console.log("ðŸ”„ MudanÃ§a detectada na playlist, atualizando cache...");
      console.log(`ðŸ“Š Cache: ${cacheAtual.length} itens | Banco: ${newPlaylist.length} itens`);
      
      currentPlaylistId = codigoConteudo;
      currentContentCode = codigoConteudo;
      subscribePlaylistChannel(currentPlaylistId);
      await atualizarPlaylist(newPlaylist, codigoConteudo, {});
    } else {
      console.log("âœ… Playlist nÃ£o mudou, mantendo cache");
    }
  } catch (err) {
    console.error("âŒ Erro ao verificar mudanÃ§as em background:", err);
  }
}

async function atualizarPlaylist(newPlaylist, playlistId, estadoAnterior = {}) {
  const {
    wasPlaying = false,
    currentTime = 0,
    wasVideo = false,
    currentUrl = null,
  } = estadoAnterior;

  // Detectar se a playlist mudou respeitando tambÃ©m a ordem dos itens
  const playlistAntiga = Array.isArray(playlist) ? playlist : [];
  const playlistNova = Array.isArray(newPlaylist) ? newPlaylist : [];

  const assinaturaAntiga = buildPlaylistSignature(playlistAntiga);
  const assinaturaNova = buildPlaylistSignature(playlistNova);
  const playlistMudou = assinaturaAntiga !== assinaturaNova;

  playlist = Array.isArray(newPlaylist) ? newPlaylist : [];
  currentPlaylistId = playlistId ?? null;
  
  // Se a playlist mudou, o Service Worker vai limpar apenas o que nÃ£o estÃ¡ na nova playlist
  // MantÃ©m automaticamente os vÃ­deos/imagens que estÃ£o na nova playlist (cache inteligente)
  if (playlistMudou && codigoAtual) {
    console.log("ðŸ”„ Playlist mudou, atualizando cache...");
    console.log(`ðŸ“Š Antes: ${playlistAntiga.length} itens | Depois: ${playlistNova.length} itens`);
    console.log("ðŸ’¡ Service Worker vai manter cache dos itens que estÃ£o na nova playlist");
    // NÃ£o limpar cache aqui - deixar o Service Worker fazer a limpeza inteligente
    // O Service Worker remove apenas os vÃ­deos que NÃƒO estÃ£o na nova playlist
  } else if (codigoAtual && playlistAntiga.length > 0) {
    console.log("âœ… Playlist nÃ£o mudou, mantendo cache existente");
  }
  
  await salvarCache(playlist, (playlistId ?? codigoAtual));

  if (!playlist.length) {
    await stopNativeVideoPlayback();
    try { video.pause(); } catch {}
    destroyHls();
    if (img.timeoutId) { clearTimeout(img.timeoutId); delete img.timeoutId; }
    isPlaying = false;
    video.style.display = "none";
    img.style.display = "none";
    currentItemUrl = null;
    activeMediaItem = null;
    activeMediaType = null;
    currentIndex = 0;
    // Playlist vazia = limpa IDB do namespace (remove arquivos do dispositivo)
    navigator.serviceWorker?.controller?.postMessage({ action: "clearNamespace" });
    // Limpa localStorage de playlist para nao recarregar conteudo antigo
    try {
      if (codigoAtual) localStorage.removeItem(cacheKeyFor(codigoAtual));
      if (currentContentCode) localStorage.removeItem(cacheKeyFor(currentContentCode));
      if (playlistId) localStorage.removeItem(cacheKeyFor(playlistId));
    } catch {}
    await atualizarStatusCache(codigoAtual, false);
    return;
  }
  
  // Verificar se cache estÃ¡ pronto apÃ³s mudanÃ§a na playlist
  setTimeout(async () => {
    console.log("ðŸ”„ Verificando cache apÃ³s mudanÃ§a na playlist...");
    await verificarEAtualizarStatusCache();
  }, 5000); // Aguardar 5 segundos para cache ser processado
  
  // ForÃ§ar cache se Service Worker nÃ£o estiver disponÃ­vel
  if (!navigator.serviceWorker.controller) {
    console.log("âš ï¸ Service Worker nÃ£o disponÃ­vel, forÃ§ando cache direto...");
    setTimeout(async () => {
      await mritDebug.forcarCacheDireto();
    }, 5000);
  } else {
    // Se Service Worker estÃ¡ disponÃ­vel, aguardar um pouco e verificar se cache funcionou
    setTimeout(async () => {
      console.log("ðŸ”„ Verificando se cache automÃ¡tico funcionou...");
      const cachePronto = await verificarEAtualizarStatusCache();
      if (!cachePronto) {
        console.log("âš ï¸ Cache automÃ¡tico falhou, forÃ§ando cache direto...");
        await mritDebug.forcarCacheDireto();
      }
    }, 10000);
  }

  const itemIndex = currentUrl
    ? playlist.findIndex(item => item && (
        item.url === currentUrl ||
        item.urlPortrait === currentUrl ||
        item.urlLandscape === currentUrl
      ))
    : -1;

  if (itemIndex >= 0) {
    // Item atual ainda existe na playlist
    currentIndex = itemIndex;

    if (wasVideo && wasPlaying) {
      try {
        if (!video.paused) return;
        video.currentTime = currentTime || video.currentTime || 0;
        await video.play().catch(() => { video.muted = true; video.play(); });
        return;
      } catch {
        tocarLoop();
        return;
      }
    }

    if (!wasVideo && wasPlaying) return;

    tocarLoop();
    return;
  }

  // Item atual nÃ£o existe mais na playlist (foi removido ou playlist mudou)
  // Limpar estado de reproduÃ§Ã£o completamente
  try { video.pause(); } catch {}
  destroyHls();
  if (img.timeoutId) { clearTimeout(img.timeoutId); delete img.timeoutId; }
  isPlaying = false;
  currentItemUrl = null;
  activeMediaItem = null;
  activeMediaType = null;

  // Garantir que currentIndex esteja dentro dos limites vÃ¡lidos
  // Se o item atual foi removido, avanÃ§ar para o prÃ³ximo item vÃ¡lido
  if (playlist.length > 0) {
    // Se currentIndex estava alÃ©m do fim ou no Ãºltimo item que foi removido
    if (currentIndex >= playlist.length) {
      // Voltar para o inÃ­cio
      currentIndex = 0;
    } else if (currentIndex < 0) {
      // Se estava negativo, voltar para o inÃ­cio
      currentIndex = 0;
    }
    // currentIndex agora estÃ¡ garantidamente dentro dos limites [0, playlist.length-1]
    
    console.log(`ðŸ”„ Item atual removido, continuando do Ã­ndice ${currentIndex} de ${playlist.length} itens`);
    
    // Pequeno delay para garantir que o estado foi limpo antes de continuar
    setTimeout(() => {
      tocarLoop();
    }, 100);
  } else {
    // Playlist vazia, jÃ¡ foi tratado acima
    console.log("âš ï¸ Playlist vazia apÃ³s remoÃ§Ã£o");
  }
}

async function salvarCache(playlistData, codigo) {
  const payload = JSON.stringify({
    playlist: playlistData,
    codigo,
    contentCode: currentContentCode ?? codigo ?? null,
    displayCode: codigoAtual ?? null,
  });

  // MantÃ©m o cache acessÃ­vel tanto pelo cÃ³digo do conteÃºdo/playlist quanto pelo cÃ³digo da tela.
  if (codigo) {
    localStorage.setItem(cacheKeyFor(codigo), payload);
  }
  if (codigoAtual) {
    localStorage.setItem(cacheKeyFor(codigoAtual), payload);
  }

  if ('serviceWorker' in navigator && navigator.serviceWorker.controller) {
    console.log("ðŸ“¤ Enviando playlist para Service Worker:", playlistData.length, "itens");
    navigator.serviceWorker.controller.postMessage({
      action: "updateCache",
      playlist: playlistData
    });
  } else {
    console.warn("âš ï¸ Service Worker nÃ£o disponÃ­vel para cache automÃ¡tico");
  }
  
  // Atualizar status do cache na tabela displays
  await atualizarStatusCache(codigo, true);
}

function postServiceWorkerMessage(action, payload = {}, awaitReply = false) {
  const controller = navigator.serviceWorker?.controller;
  if (!controller) return Promise.resolve(null);

  if (!awaitReply) {
    controller.postMessage({ action, ...payload });
    return Promise.resolve(null);
  }

  return new Promise((resolve, reject) => {
    const channel = new MessageChannel();
    const timeoutId = setTimeout(() => reject(new Error(`timeout aguardando resposta do SW para ${action}`)), 5000);
    channel.port1.onmessage = (event) => {
      clearTimeout(timeoutId);
      resolve(event.data || null);
    };
    controller.postMessage({ action, ...payload }, [channel.port2]);
  });
}

async function limparCacheAtualEReload() {
  const alvoConteudo = currentContentCode || currentPlaylistId || codigoAtual;
  console.log("🧹 Limpando cache da tela atual e recarregando conteúdo:", {
    codigoAtual,
    currentContentCode,
    currentPlaylistId,
  });

  try {
    if (codigoAtual) localStorage.removeItem(cacheKeyFor(codigoAtual));
    if (currentContentCode) localStorage.removeItem(cacheKeyFor(currentContentCode));
    if (currentPlaylistId) localStorage.removeItem(cacheKeyFor(currentPlaylistId));
  } catch {}

  try {
    await postServiceWorkerMessage("clearNamespace", {}, true);
  } catch (err) {
    console.warn("⚠️ Falha ao aguardar limpeza do cache no Service Worker:", err?.message || err);
    navigator.serviceWorker?.controller?.postMessage({ action: "clearNamespace" });
  }

  try { await stopNativeVideoPlayback(); } catch {}
  try { video.pause(); } catch {}
  destroyHls();
  if (img.timeoutId) { clearTimeout(img.timeoutId); delete img.timeoutId; }
  isPlaying = false;
  isLoadingVideo = false;
  currentItemUrl = null;
  activeMediaItem = null;
  activeMediaType = null;
  preloadedBufferUrl = null;
  preloadingBuffer = false;
  playToken++;
  currentVideoToken++;

  if (codigoAtual) {
    await atualizarStatusCache(codigoAtual, false);
  }

  if (alvoConteudo) {
    await carregarConteudo(alvoConteudo);
  }
}

// Reset agressivo quando entra com um novo cÃ³digo
async function resetAllCachesForNewCode() {
  // limpa caches antigos de playlists (todas as telas)
  Object.keys(localStorage).forEach(k => {
    if (k.startsWith("playlist_cache_")) localStorage.removeItem(k);
  });

  // pede para o SW limpar qualquer namespace ainda ativo (se houver)
  navigator.serviceWorker?.controller?.postMessage({ action: "clearNamespace" });

  // zera os elementos de mÃ­dia (ativo + buffer)
  for (const v of getUniqueVideoEls()) {
    try { v.pause(); } catch {}
    revokeElementObjectUrl(v);
    v.removeAttribute("src");
    v.load();
  }
  preloadedBufferUrl = null;
  
  // Resetar flag de primeiro ciclo quando novo código é carregado
  isFirstCycle = true;
  preloadingBuffer = false;
  await stopNativeVideoPlayback();
  stopPlaybackWatchdog();
  isLoadingVideo = false;
  playToken++;
  currentVideoToken++;
  img.src = "";
  revokeElementObjectUrl(img);
  
  // Marcar cache como nÃ£o pronto ao trocar de cÃ³digo
  if (codigoAtual) {
    await atualizarStatusCache(codigoAtual, false);
  }
}

async function tocarLoop() {
  if (!playlist.length) {
    await stopNativeVideoPlayback();
    for (const v of getUniqueVideoEls()) v.style.display = "none";
    img.style.display = "none";
    isPlaying = false;
    isLoadingVideo = false;
    return;
  }

  if (img.timeoutId) { clearTimeout(img.timeoutId); delete img.timeoutId; }
  feedFechar();
  if (!isNativeMediaModeActive()) {
    await stopNativeVideoPlayback();
  }
  stopPlaybackWatchdog();
  for (const v of getUniqueVideoEls()) v.onended = null;
  img.onload = null;
  img.onerror = null;
  restoreMediaLayerStyles();

  currentIndex = currentIndex % playlist.length;
  let item = null;
  let itemUrl = null;
  let attempts = 0;
  while (attempts < playlist.length) {
    const candidate = playlist[currentIndex];
    const candidateUrl = candidate ? pickSourceForOrientation(candidate) : null;
    if (candidate && candidateUrl && !isItemOnCooldown(candidateUrl)) {
      item = candidate;
      itemUrl = candidateUrl;
      break;
    }
    currentIndex = (currentIndex + 1) % playlist.length;
    attempts++;
  }
  if (!item || !itemUrl) {
    console.warn("[playback] all items unavailable/cooling down; waiting and retrying...");
    // Se chegamos aqui, significa que todos os itens da playlist estão em cooldown
    // ou inválidos. Para evitar loop infinito apenas em poucos itens, limpamos o
    // estado de falha/cooldown e tentamos novamente em seguida.
    if (itemFailureState.size > 0) {
      console.warn("[playback] resetando cooldown de todos os itens para destravar a playlist");
      itemFailureState.clear();
    }
    setTimeout(() => tocarLoop(), 1000);
    return;
  }

  currentItemUrl = itemUrl;

  // -- Feed (informativo) --
  if ((item && item.tipo || '').toLowerCase() === 'feed') {
    activeMediaItem = item;
    activeMediaType = 'feed';
    for (var _fv of getUniqueVideoEls()) _fv.style.display = 'none';
    img.style.display = 'none';
    var _feedToken = ++playToken;
    tocarFeedItem(item, _feedToken);
    return;
  }

  const isHls = /\.m3u8(\?|$)/i.test(itemUrl);
  const isVideo = isVideoItem(item, itemUrl);
  activeMediaItem = item;
  activeMediaType = isVideo ? "video" : "image";
  const preferLocalCachePlayback = !navigator.onLine || !navigator.serviceWorker.controller;

  const myToken = ++playToken;
  const duration = (item.duration !== undefined) ? item.duration : (isVideo ? null : 15000);

  if (isVideo) {
    if (isLoadingVideo) { setTimeout(() => tocarLoop(), 60); return; }

    const nativeOnlyMode = isNativeMediaModeActive();
    const nativeStarted = await tryPlayWithNativeExo(item, itemUrl, myToken);
    if (nativeStarted) {
      nativePreloadUpcomingItem(currentIndex).catch(() => {});
      return;
    }
    if (nativeOnlyMode) {
      console.warn("[native-exo] strict mode active; skipping web fallback for:", itemUrl);
      registerItemFailure(itemUrl, "native_exo_required");
      isPlaying = false;
      proximoItem();
      return;
    }

    isLoadingVideo = true;
    currentVideoToken++;
    const videoToken = currentVideoToken;

    const previousVideo = video;
    const nextVideo = (videoBuffer && videoBuffer !== previousVideo) ? videoBuffer : previousVideo;
    const safetyTimeout = setTimeout(() => { if (isLoadingVideo) isLoadingVideo = false; }, 15000);
    let playbackUrl = itemUrl;

    try {
      nextVideo.muted = true;
      nextVideo.playsInline = true;
      nextVideo.setAttribute("crossorigin", "anonymous");
      nextVideo.preload = "auto";
      revokeElementObjectUrl(nextVideo);

      if (!isHls && preferLocalCachePlayback) {
        const cachedPlaybackUrl = await getPlayableCachedSource(itemUrl, "video");
        if (cachedPlaybackUrl) {
          playbackUrl = cachedPlaybackUrl;
          console.log("📦 Reproduzindo vídeo direto do cache local:", itemUrl);
        } else if (!navigator.onLine) {
          throw new Error("video offline sem cache local");
        }
      }

      if (!isHls && preloadedBufferUrl === itemUrl && nextVideo.readyState >= 2) {
        // Buffer já aquecido: troca praticamente instantânea.
      } else if (isHls) {
        destroyHls();
        if (nextVideo.canPlayType("application/vnd.apple.mpegurl")) {
          setMediaElementSource(nextVideo, itemUrl);
          nextVideo.load();
          const ok = await waitForVideoReady(nextVideo, 6000);
          if (!ok) throw new Error("hls nativo nao pronto");
        } else if (window.Hls && window.Hls.isSupported()) {
          hls = new Hls({ maxBufferLength: 20, maxMaxBufferLength: 40 });
          await new Promise((resolve, reject) => {
            let done = false;
            const t = setTimeout(() => {
              if (done) return;
              done = true;
              reject(new Error("timeout hls"));
            }, 4000);
            hls.loadSource(itemUrl);
            hls.attachMedia(nextVideo);
            hls.on(Hls.Events.MANIFEST_PARSED, () => {
              if (done) return;
              done = true;
              clearTimeout(t);
              resolve(true);
            });
            hls.on(Hls.Events.ERROR, (evt, data) => {
              if (done || !data?.fatal) return;
              done = true;
              clearTimeout(t);
              reject(new Error("erro hls fatal"));
            });
          });
        } else {
          setMediaElementSource(nextVideo, itemUrl);
          nextVideo.load();
          const ok = await waitForVideoReady(nextVideo, 6000);
          if (!ok) throw new Error("hls fallback nao pronto");
        }
      } else {
        setMediaElementSource(nextVideo, playbackUrl);
        nextVideo.load();
        const ok = await waitForVideoReady(nextVideo, 6000);
        if (!ok || nextVideo.readyState < 3) throw new Error("video nao pronto");
      }

      const persistVideoDuration = () => {
        const detectedDuration = Number(nextVideo.duration || 0);
        if (Number.isFinite(detectedDuration) && detectedDuration > 0) {
          rememberVideoDuration(itemUrl, detectedDuration);
        }
      };
      nextVideo.addEventListener("loadedmetadata", persistVideoDuration, { once: true });
      nextVideo.addEventListener("durationchange", persistVideoDuration, { once: true });
      persistVideoDuration();
      const reapplyVideoFitWhenDimensionsChange = () => {
        if (myToken !== playToken || videoToken !== currentVideoToken) return;
        reapplyActiveMediaFit();
      };
      nextVideo.addEventListener("loadedmetadata", reapplyVideoFitWhenDimensionsChange, { once: true });
      nextVideo.addEventListener("resize", reapplyVideoFitWhenDimensionsChange, { once: true });

      if (myToken !== playToken || videoToken !== currentVideoToken) {
        isLoadingVideo = false;
        clearTimeout(safetyTimeout);
        return;
      }

      // Garantir início no começo para evitar "fim imediato" em elementos reutilizados.
      try { nextVideo.currentTime = 0; } catch {}

      const fit = getSmartMediaFit(item, "video", itemUrl, nextVideo);
      const focus = item.focus || "center center";
      applyFit(nextVideo, fit, focus);

      img.style.display = "none";
      img.src = "";

      nextVideo.style.display = "block";
      nextVideo.style.visibility = "visible";
      nextVideo.classList.add("hidden-ready");
      nextVideo.style.opacity = "0";

      isPlaying = true;
      videoRetryCount = 0;
      lastFailedUrl = null;
      lastFailedRetries = 0;
      isLoadingVideo = false;
      clearTimeout(safetyTimeout);

      let didSwap = false;
      let swapFallbackId = null;
      const finalizeSwap = () => {
        if (didSwap) return;
        if (myToken !== playToken || videoToken !== currentVideoToken) return;
        didSwap = true;
        if (swapFallbackId) {
          clearTimeout(swapFallbackId);
          swapFallbackId = null;
        }
        nextVideo.classList.remove("hidden-ready");
        nextVideo.style.opacity = "1";

        if (previousVideo && previousVideo !== nextVideo) {
          previousVideo.style.display = "none";
          previousVideo.classList.remove("hidden-ready");
          try {
            previousVideo.pause();
            revokeElementObjectUrl(previousVideo);
            previousVideo.removeAttribute("src");
            previousVideo.load();
          } catch {}
        }

        video = nextVideo;
        videoBuffer = previousVideo || nextVideo;
        preloadedBufferUrl = null;
        clearItemFailure(itemUrl);
        startPlaybackWatchdog(nextVideo, myToken, itemUrl);
        preloadUpcomingVideoInBuffer(currentIndex).catch(() => {});
      };

      const onSwapReady = () => {
        nextVideo.removeEventListener("playing", onSwapReady);
        nextVideo.removeEventListener("timeupdate", onSwapReady);
        finalizeSwap();
      };

      nextVideo.addEventListener("playing", onSwapReady, { once: true });
      nextVideo.addEventListener("timeupdate", onSwapReady, { once: true });
      swapFallbackId = setTimeout(() => {
        if (!nextVideo.paused && nextVideo.readyState >= 3) finalizeSwap();
      }, 450);

      nextVideo.play().catch(() => {
        nextVideo.muted = true;
        nextVideo.play().catch(() => {
          nextVideo.removeEventListener("playing", onSwapReady);
          nextVideo.removeEventListener("timeupdate", onSwapReady);
          if (swapFallbackId) {
            clearTimeout(swapFallbackId);
            swapFallbackId = null;
          }
          nextVideo.style.display = "none";
          nextVideo.classList.remove("hidden-ready");
          nextVideo.style.opacity = "1";
          if (lastFailedUrl === itemUrl) {
            lastFailedRetries += 1;
          } else {
            lastFailedUrl = itemUrl;
            lastFailedRetries = 1;
          }

          if (lastFailedRetries > 1) {
            lastFailedUrl = null;
            lastFailedRetries = 0;
            if (weakDeviceDetected) enableReducedMediaMode(`play_start_failed:${itemUrl}`);
            registerItemFailure(itemUrl, "play_start_failed_twice");
            proximoItem();
            return;
          }
          setTimeout(() => tocarLoop(), 120);
        });
      });

      const onEndedToken = myToken;
      const startedAt = performance.now();
      nextVideo.onended = () => {
        if (onEndedToken !== playToken) return;
        const elapsed = performance.now() - startedAt;
        if (elapsed < 250) {
          if (lastShortEndUrl === itemUrl) {
            lastShortEndRetries += 1;
          } else {
            lastShortEndUrl = itemUrl;
            lastShortEndRetries = 1;
          }
          if (lastShortEndRetries <= 1) {
            isPlaying = false;
            setTimeout(() => tocarLoop(), 80);
            return;
          }
          if (weakDeviceDetected) enableReducedMediaMode(`very_short_end:${itemUrl}`);
          registerItemFailure(itemUrl, "very_short_end");
        } else {
          lastShortEndUrl = null;
          lastShortEndRetries = 0;
          clearItemFailure(itemUrl);
        }
        isPlaying = false;
        stopPlaybackWatchdog();
        proximoItem();
        verificarMudancasPosTrocaEmBackground();
      };
    } catch (e) {
      isLoadingVideo = false;
      stopPlaybackWatchdog();
      clearTimeout(safetyTimeout);
      if (lastFailedUrl === itemUrl) {
        lastFailedRetries += 1;
      } else {
        lastFailedUrl = itemUrl;
        lastFailedRetries = 1;
      }

      if (lastFailedRetries > 1) {
        lastFailedUrl = null;
        lastFailedRetries = 0;
        videoRetryCount = 0;
        isPlaying = false;
        enableReducedMediaMode(`load_failed:${itemUrl}`);
        registerItemFailure(itemUrl, "load_failed_twice");
        proximoItem();
        return;
      }
      if (videoRetryCount < MAX_VIDEO_RETRIES) {
        videoRetryCount++;
        setTimeout(() => tocarLoop(), 150);
        return;
      }
      videoRetryCount = 0;
      isPlaying = false;
      proximoItem();
    }
    return;
  }

  if (isNativeMediaModeActive()) {
    const nativeImageStarted = await tryShowImageNative(item, itemUrl, myToken);
    if (nativeImageStarted) {
      nativePreloadUpcomingItem(currentIndex).catch(() => {});
      const imageDuration = (typeof duration === "number" && duration > 0) ? duration : 15000;
      if (img.timeoutId) { clearTimeout(img.timeoutId); delete img.timeoutId; }
      img.timeoutId = setTimeout(() => {
        if (myToken !== playToken) return;
        isPlaying = false;
        proximoItem();
        verificarMudancasPosTrocaEmBackground();
      }, imageDuration);
      return;
    }
    console.warn("[native-media] strict mode active; skipping web image fallback for:", itemUrl);
    registerItemFailure(itemUrl, "native_image_required");
    isPlaying = false;
    proximoItem();
    return;
  }

  img.onload = () => {
    if (myToken !== playToken) return;
    stopNativeVideoPlayback().catch(() => {});
    const fit = getSmartMediaFit(item, "image", itemUrl, img);
    const focus = item.focus || "center center";
    applyFit(img, fit, focus);

    for (const v of getUniqueVideoEls()) {
      try {
        v.pause();
        v.currentTime = 0;
        revokeElementObjectUrl(v);
        v.removeAttribute("src");
        v.load();
      } catch {}
      v.style.display = "none";
      v.classList.remove("hidden-ready");
    }
    preloadedBufferUrl = null;
    preloadingBuffer = false;
    stopPlaybackWatchdog();

    img.style.display = "block";
    img.style.visibility = "visible";
    img.classList.remove("hidden-ready");
    img.style.opacity = "1";
    clearItemFailure(itemUrl);
    isPlaying = true;

    if (typeof duration === "number" && duration > 0) {
      img.timeoutId = setTimeout(() => {
        if (myToken !== playToken) return;
        isPlaying = false;
        proximoItem();
        verificarMudancasPosTrocaEmBackground();
      }, duration);
    }

    // Se o próximo item for vídeo, já pré-aquece durante exibição da imagem.
    preloadUpcomingVideoInBuffer(currentIndex).catch(() => {});
  };

  img.onerror = () => {
    isPlaying = false;
    registerItemFailure(itemUrl, "image_error");
    proximoItem();
  };

  let imagePlaybackUrl = itemUrl;
  if (preferLocalCachePlayback) {
    const cachedImageUrl = await getPlayableCachedSource(itemUrl, "image");
    if (cachedImageUrl) {
      imagePlaybackUrl = cachedImageUrl;
      console.log("📦 Reproduzindo imagem direto do cache local:", itemUrl);
    } else if (!navigator.onLine) {
      img.onerror?.();
      return;
    }
  }

  setMediaElementSource(img, imagePlaybackUrl);
}


// ===== Detectar velocidade de rede =====
let networkSpeed = 'normal'; // 'slow', 'normal', 'fast'
let lastNetworkCheck = 0;
const NETWORK_CHECK_INTERVAL = 30000; // Verificar a cada 30s

async function detectNetworkSpeed() {
  const now = Date.now();
  if (now - lastNetworkCheck < NETWORK_CHECK_INTERVAL) {
    return networkSpeed; // Usar cache
  }
  
  lastNetworkCheck = now;
  
  try {
    const startTime = performance.now();
    // Usar AbortController para compatibilidade com navegadores mais antigos
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);
    
    const response = await fetch(`${supabaseUrl}/rest/v1/displays?limit=1`, {
      method: 'HEAD',
      cache: 'no-store',
      signal: controller.signal
    });
    
    clearTimeout(timeoutId);
    const endTime = performance.now();
    const duration = endTime - startTime;
    
    if (duration > 3000) {
      networkSpeed = 'slow';
      console.log("ðŸŒ Internet lenta detectada:", duration.toFixed(0), "ms");
    } else if (duration < 500) {
      networkSpeed = 'fast';
      console.log("âš¡ Internet rÃ¡pida detectada:", duration.toFixed(0), "ms");
    } else {
      networkSpeed = 'normal';
    }
    
    return networkSpeed;
  } catch (err) {
    networkSpeed = 'slow';
    console.log("ðŸŒ Assumindo internet lenta devido a erro:", err.message);
    return 'slow';
  }
}

function getAdaptiveTimeout(baseTimeout) {
  if (networkSpeed === 'slow') {
    return baseTimeout * 3; // 3x mais tempo para internet lenta
  } else if (networkSpeed === 'fast') {
    return baseTimeout * 0.7; // 30% menos tempo para internet rÃ¡pida
  }
  return baseTimeout;
}

function waitForCanPlay(videoEl, timeoutMs = 7000) {
  return new Promise(async (resolve) => {
    if (videoEl.readyState >= 3) return resolve(true);
    
    // Ajustar timeout baseado na velocidade de rede
    const adaptiveTimeout = await detectNetworkSpeed().then(speed => {
      if (speed === 'slow') return timeoutMs * 3;
      if (speed === 'fast') return timeoutMs * 0.7;
      return timeoutMs;
    });
    
    let done = false;
    const onCanPlay = () => { if (!done) { done = true; cleanup(); resolve(true); } };
    const t = setTimeout(() => { if (!done) { done = true; cleanup(); resolve(false); } }, adaptiveTimeout);
    function cleanup() { clearTimeout(t); videoEl.removeEventListener("canplay", onCanPlay); }
    videoEl.addEventListener("canplay", onCanPlay, { once: true });
  });
}

// ===== FunÃ§Ãµes de Buffering Melhoradas =====

/**
 * Verifica se o vÃ­deo tem buffer suficiente (em segundos)
 * @param {HTMLVideoElement} videoEl - Elemento de vÃ­deo
 * @param {number} minSeconds - Segundos mÃ­nimos de buffer necessÃ¡rio
 * @returns {boolean} - true se tem buffer suficiente
 */
function hasEnoughBuffer(videoEl, minSeconds) {
  if (!videoEl.buffered || !videoEl.buffered.length) return false;
  if (!videoEl.duration || !isFinite(videoEl.duration)) return false;
  
  // Se o vÃ­deo Ã© mais curto que o buffer mÃ­nimo, aceita se tiver carregado completamente
  if (videoEl.duration < minSeconds) {
    return videoEl.readyState >= 3; // Aceita se jÃ¡ pode tocar
  }
  
  const bufferedEnd = videoEl.buffered.end(videoEl.buffered.length - 1);
  const currentTime = videoEl.currentTime || 0;
  const bufferedSeconds = bufferedEnd - currentTime;
  
  // Para vÃ­deos curtos, aceita se tiver pelo menos 80% do vÃ­deo em buffer
  if (videoEl.duration <= minSeconds * 1.5) {
    return bufferedSeconds >= (videoEl.duration * 0.8);
  }
  
  return bufferedSeconds >= minSeconds;
}

/**
 * Espera o vÃ­deo ter buffer mÃ­nimo antes de tocar (modo progressivo)
 * @param {HTMLVideoElement} videoEl - Elemento de vÃ­deo
 * @param {number} minBufferSeconds - Segundos mÃ­nimos de buffer
 * @param {number} timeoutMs - Timeout mÃ¡ximo em milissegundos
 * @returns {Promise<boolean>} - true se conseguiu buffer suficiente
 */
function waitForBuffer(videoEl, minBufferSeconds, timeoutMs = 15000) {
  return new Promise(async (resolve) => {
    // Se jÃ¡ tem buffer suficiente, retorna imediatamente
    if (hasEnoughBuffer(videoEl, minBufferSeconds)) {
      return resolve(true);
    }
    
    // Ajustar timeout baseado na velocidade de rede
    const adaptiveTimeout = await detectNetworkSpeed().then(speed => {
      if (speed === 'slow') return timeoutMs * 2.5;
      if (speed === 'fast') return timeoutMs * 0.8;
      return timeoutMs;
    });
    
    let done = false;
    let checkInterval = null;
    let timeoutId = null;
    
    const checkBuffer = () => {
      if (done) return;
      
      // Se o vÃ­deo jÃ¡ carregou completamente, aceita imediatamente
      if (videoEl.readyState >= 4) {
        done = true;
        cleanup();
        resolve(true);
        return;
      }
      
      // Para vÃ­deos muito curtos (menos que o buffer mÃ­nimo), aceita se readyState >= 3
      if (videoEl.duration && videoEl.duration < minBufferSeconds && videoEl.readyState >= 3) {
        done = true;
        cleanup();
        resolve(true);
        return;
      }
      
      if (hasEnoughBuffer(videoEl, minBufferSeconds)) {
        done = true;
        cleanup();
        resolve(true);
        return;
      }
    };
    
    const cleanup = () => {
      if (checkInterval) clearInterval(checkInterval);
      if (timeoutId) clearTimeout(timeoutId);
      videoEl.removeEventListener("progress", checkBuffer);
      videoEl.removeEventListener("canplay", checkBuffer);
      videoEl.removeEventListener("canplaythrough", checkBuffer);
    };
    
    // Verificar periodicamente enquanto o vÃ­deo carrega
    checkInterval = setInterval(checkBuffer, 200);
    
    // Timeout mÃ¡ximo
    timeoutId = setTimeout(() => {
      if (!done) {
        done = true;
        cleanup();
        // Se tem pelo menos algum buffer (mesmo que nÃ£o seja o mÃ­nimo), aceita
        const hasAnyBuffer = videoEl.buffered && videoEl.buffered.length > 0 && 
                             videoEl.buffered.end(0) > videoEl.currentTime;
        resolve(hasAnyBuffer || videoEl.readyState >= 3);
      }
    }, adaptiveTimeout);
    
    // Eventos do vÃ­deo
    videoEl.addEventListener("progress", checkBuffer);
    videoEl.addEventListener("canplay", checkBuffer);
    videoEl.addEventListener("canplaythrough", checkBuffer);
    
    // VerificaÃ§Ã£o inicial
    checkBuffer();
  });
}

/**
 * Espera o vÃ­deo carregar 100% antes de tocar (modo completo)
 * @param {HTMLVideoElement} videoEl - Elemento de vÃ­deo
 * @param {number} timeoutMs - Timeout mÃ¡ximo em milissegundos
 * @returns {Promise<boolean>} - true se carregou completamente
 */
function waitForLoaded(videoEl, timeoutMs = 30000) {
  return new Promise(async (resolve) => {
    // Se jÃ¡ estÃ¡ completamente carregado, retorna imediatamente
    if (videoEl.readyState >= 4) {
      return resolve(true);
    }
    
    // Ajustar timeout baseado na velocidade de rede
    const adaptiveTimeout = await detectNetworkSpeed().then(speed => {
      if (speed === 'slow') return timeoutMs * 3;
      if (speed === 'fast') return timeoutMs * 0.8;
      return timeoutMs;
    });
    
    let done = false;
    let timeoutId = null;
    
    const onLoaded = () => {
      if (!done && videoEl.readyState >= 4) {
        done = true;
        cleanup();
        resolve(true);
      }
    };
    
    const cleanup = () => {
      if (timeoutId) clearTimeout(timeoutId);
      videoEl.removeEventListener("canplaythrough", onLoaded);
      videoEl.removeEventListener("loadeddata", onLoaded);
    };
    
    // Timeout mÃ¡ximo
    timeoutId = setTimeout(() => {
      if (!done) {
        done = true;
        cleanup();
        // Aceita se tem pelo menos buffer suficiente para comeÃ§ar
        resolve(videoEl.readyState >= 3);
      }
    }, adaptiveTimeout);
    
    // Eventos do vÃ­deo
    videoEl.addEventListener("canplaythrough", onLoaded, { once: true });
    videoEl.addEventListener("loadeddata", onLoaded);
    
    // VerificaÃ§Ã£o inicial
    if (videoEl.readyState >= 4) {
      onLoaded();
    }
  });
}

/**
 * FunÃ§Ã£o unificada que escolhe o modo de buffering baseado na configuraÃ§Ã£o
 * @param {HTMLVideoElement} videoEl - Elemento de vÃ­deo
 * @param {number} baseTimeoutMs - Timeout base em milissegundos
 * @returns {Promise<boolean>} - true se estÃ¡ pronto para tocar
 */
async function waitForVideoReady(videoEl, baseTimeoutMs = 7000) {
  switch (BUFFERING_MODE) {
    case "full":
      return await waitForLoaded(videoEl, baseTimeoutMs * 2);
    
    case "progressive":
      // Primeiro espera canplay, depois espera buffer mÃ­nimo
      const canPlay = await waitForCanPlay(videoEl, baseTimeoutMs);
      if (!canPlay) return false;
      return await waitForBuffer(videoEl, MIN_BUFFER_SECONDS, baseTimeoutMs * 1.5);
    
    case "immediate":
    default:
      return await waitForCanPlay(videoEl, baseTimeoutMs);
  }
}

async function verificarMudancasPosTrocaEmBackground() {
  if (cycleCheckInFlight) return;
  cycleCheckInFlight = true;
  try {
    const mudou = await verificarCodigoDispositivoAoCiclo();
    if (mudou) return;
    if (pendingResync) {
      pendingResync = false;
      await carregarConteudo(currentPlaylistId || codigoAtual);
    }
  } catch (err) {
    console.warn("âš ï¸ Erro na verificacao pos-troca:", err);
  } finally {
    cycleCheckInFlight = false;
  }
}

// ===== Verificar cÃ³digo do dispositivo ao final de ciclo =====
async function verificarCodigoDispositivoAoCiclo() {
  if (!codigoAtual || !navigator.onLine) return false;
  
  try {
    const deviceId = gerarDeviceId();
    
    const { data: dispositivo, error } = await client
      .from("dispositivos")
      .select("codigo_display, local_nome")
      .eq("device_id", deviceId)
      .eq("is_ativo", true)
      .maybeSingle();
    
    if (error) {
      // Se tabela nÃ£o existir, ignorar
      if (error.message && error.message.includes('relation') && error.message.includes('does not exist')) {
        return false;
      }
      return false;
    }
    
    if (dispositivo && dispositivo.codigo_display && dispositivo.codigo_display !== codigoAtual) {
      console.log("ðŸ”„ CÃ³digo mudou ao final do ciclo:", codigoAtual, "â†’", dispositivo.codigo_display);
      
      const novoCodigo = dispositivo.codigo_display;
      const codigoAntigo = codigoAtual;
      
            // Desbloquear display antigo
            if (codigoAntigo && codigoAntigo !== novoCodigo) {
              try {
                await client
                  .from("displays")
                  .update({ is_locked: false, status: "DisponÃ­vel" })
                  .eq("codigo_unico", codigoAntigo);
              } catch (err) {
                console.warn("âš ï¸ Erro ao desbloquear display antigo:", err);
              }
            }
      
      // Bloquear novo display
      try {
        await client
          .from("displays")
          .update({ 
            is_locked: true, 
            status: "Em uso"
          })
          .eq("codigo_unico", novoCodigo);
      } catch (err) {
        console.warn("âš ï¸ Erro ao bloquear novo display:", err);
      }
      
      // Atualizar localStorage
      localStorage.setItem(CODIGO_DISPLAY_KEY, novoCodigo);
      if (dispositivo.local_nome) {
        localStorage.setItem(LOCAL_TELA_KEY, dispositivo.local_nome);
      }
      
      // Atualizar variÃ¡vel global
      codigoAtual = novoCodigo;
      
      // Limpar cache antigo
      await resetAllCachesForNewCode();
      
      // Recarregar conteÃºdo com novo cÃ³digo
      await carregarConteudo(novoCodigo);
      
      console.log("âœ… CÃ³digo alterado ao final do ciclo e conteÃºdo recarregado");
      return true; // Indica que mudou
    }
    
    return false; // NÃ£o mudou
  } catch (err) {
    console.warn("âš ï¸ Erro ao verificar cÃ³digo do dispositivo:", err);
    return false;
  }
}

function proximoItem() {
  // imagem Ãºnica estÃ¡tica: nÃ£o avanÃ§a
  if (!currentPlaylistId && playlist.length === 1) {
    const only = playlist[0];
    const onlyUrl = pickSourceForOrientation(only);
    const isImg = isImageItem(only, onlyUrl);
    if (isImg && only.duration === 0) {
      // Verificar cÃ³digo mesmo em imagem estÃ¡tica
      verificarCodigoDispositivoAoCiclo();
      return;
    }
  }

  if (!playlist.length) {
    carregarConteudo(currentPlaylistId || codigoAtual);
    return;
  }
  
  // Detectar fim de ciclo: quando currentIndex volta para 0
  const indexAnterior = currentIndex;
  currentIndex = (currentIndex + 1) % playlist.length;
  const cicloCompleto = indexAnterior === playlist.length - 1 && currentIndex === 0;

  // Marcar fim do primeiro ciclo para habilitar cache e pré-carregamento
  if (cicloCompleto && isFirstCycle) {
    isFirstCycle = false;
    console.log("✅ Primeiro ciclo completo! Cache e pré-carregamento habilitados.");
  }

  // Mantem playlist atualizada durante a rotacao (novo item/reordem/remocao)
  if (navigator.onLine && currentPlaylistId) {
    const now = Date.now();
    if (now - lastCycleRefreshAt >= 5000) {
      lastCycleRefreshAt = now;
      verificarMudancasPlaylistEmBackground(currentPlaylistId, currentPlaylistId).catch(err => {
        console.error("❌ Erro ao verificar mudancas da playlist:", err);
      });
    }
  }
  
  // Ao fim de cada ciclo, verificar se cÃ³digo mudou na tabela dispositivos
  if (cicloCompleto && navigator.onLine) {
    console.log("ðŸ”„ Ciclo completo: verificando em background sem bloquear troca.");
    verificarCodigoDispositivoAoCiclo().then((mudou) => {
      if (mudou) return;
    }).catch(err => {
      console.warn("âš ï¸ Erro na verificaÃ§Ã£o de ciclo:", err);
    });
  }
  
  tocarLoop();
}

// ===== Realtime =====
function subscribePlaylistChannel(playlistId) {
  if (playlistChannel) {
    client.removeChannel(playlistChannel);
    playlistChannel = null;
  }
  if (!playlistId) return; // conteÃºdo Ãºnico

  playlistChannel = client
    .channel(`realtime:playlist_itens:${playlistId}`)
    .on(
      "postgres_changes",
      {
        event: "*",
        schema: "public",
        table: "playlist_itens",
        filter: `playlist_id=eq.${playlistId}`,
      },
      async (payload) => {
        const evt = payload.eventType || payload.type;

        // Invalida cache localStorage antes de recarregar do banco
        if (currentPlaylistId) localStorage.removeItem(cacheKeyFor(currentPlaylistId));
        if (codigoAtual) localStorage.removeItem(cacheKeyFor(codigoAtual));
        if (currentContentCode) localStorage.removeItem(cacheKeyFor(currentContentCode));

        if (evt === "DELETE" && payload?.old?.url && (payload.old.url === currentItemUrl)) {
          try { video.pause(); } catch {}
          destroyHls();
          if (img.timeoutId) { clearTimeout(img.timeoutId); delete img.timeoutId; }
          isPlaying = false;
          await carregarConteudo(currentPlaylistId);
          proximoItem();
          return;
        }

        await carregarConteudo(currentPlaylistId);
      }
    )
    .subscribe((status, err) => {
      if (status === 'SUBSCRIBED') {
        console.log('[realtime] playlist_itens conectado');
      } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
        console.warn('[realtime] playlist_itens falhou (' + status + '):', err?.message || err);
        setTimeout(() => { if (codigoAtual) subscribePlaylistChannel(currentPlaylistId); }, 5000);
      }
    });
}

function iniciarRealtime() {
  if (displaysChannel) client.removeChannel(displaysChannel);

  displaysChannel = client
    .channel(`realtime:displays:${codigoAtual}`)
    .on(
      "postgres_changes",
      { event: "UPDATE", schema: "public", table: "displays", filter: `codigo_unico=eq.${codigoAtual}` },
      async (payload) => {
        // Verificar mudanca de device_id (atribuicao remota de novo codigo)
        try {
          const deviceId = gerarDeviceId();
          if (payload.new.device_id && payload.new.device_id === deviceId && payload.new.device_id !== payload.old?.device_id) {
            const novoCodigo = payload.new.codigo_unico || codigoAtual;
            localStorage.setItem(CODIGO_DISPLAY_KEY, novoCodigo);
            location.reload();
            return;
          }
        } catch (err) {}

        // Filtro ja garante que e este display — nao precisa checar codigo_unico no payload

        // is_locked = false => exibicao parada
        const isLocked = payload.new.is_locked;
        if (isLocked === false) {
          console.log("[realtime] display desbloqueado, parando exibicao...");
          try {
            const deviceId = gerarDeviceId();
            await client.from("dispositivos").update({ is_ativo: false }).eq("device_id", deviceId);
          } catch {}
          await pararTudoMostrarLogin();
          return;
        }

        const orientationChanged = applyDisplayOrientationSetting(payload.new.orientacao);
        const novoCodigo = payload.new.codigo_conteudoAtual;

        if (novoCodigo !== undefined) {
          if (novoCodigo && novoCodigo !== currentContentCode) {
            console.log("[realtime] conteudo alterado remotamente:", novoCodigo);
            // Invalida cache para forcar reload do banco
            localStorage.removeItem(cacheKeyFor(novoCodigo));
            localStorage.removeItem(cacheKeyFor(codigoAtual));
            if (currentContentCode) localStorage.removeItem(cacheKeyFor(currentContentCode));
            carregarConteudo(novoCodigo);
          } else if (!novoCodigo && currentContentCode) {
            await pararExibicaoIdle();
          } else if (orientationChanged && currentContentCode) {
            carregarConteudo(currentContentCode);
          }
        } else if (orientationChanged && currentContentCode) {
          carregarConteudo(currentContentCode);
        }

        await verificarPromocaoContinuamente();
      }
    )
    .subscribe((status, err) => {
      if (status === 'SUBSCRIBED') {
        console.log('[realtime] displays conectado');
      } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
        console.warn('[realtime] displays falhou (' + status + '):', err?.message || err);
        setTimeout(() => { if (codigoAtual) iniciarRealtime(); }, 5000);
      }
    });

  subscribePlaylistChannel(currentPlaylistId);
  subscribeDispositivosChannel();
  subscribeDeviceCommandsChannel();
  subscribePromoChannel();
}

// ===== Realtime para dispositivos =====
function subscribeDispositivosChannel() {
  if (dispositivosChannel) {
    client.removeChannel(dispositivosChannel);
    dispositivosChannel = null;
  }
  
  const deviceId = gerarDeviceId();
  console.log("ðŸ”Œ Conectando realtime para dispositivo:", deviceId);
  
  try {
    dispositivosChannel = client
      .channel("realtime:dispositivos")
      .on(
        "postgres_changes",
        {
          event: "UPDATE",
          schema: "public",
          table: "dispositivos",
          filter: `device_id=eq.${deviceId}`,
        },
        async (payload) => {
          console.log("ðŸ“¡ Realtime recebido - dispositivos:", payload);
          // Se codigo_display mudou remotamente, atualizar
          if (payload.new.codigo_display && payload.new.codigo_display !== payload.old?.codigo_display) {
            const novoCodigo = payload.new.codigo_display;
            const codigoAntigo = codigoAtual;
            
            console.log("ðŸ”„ CÃ³digo do display alterado remotamente:", codigoAntigo, "â†’", novoCodigo);
            
            // Desbloquear display antigo (se existir)
            if (codigoAntigo && codigoAntigo !== novoCodigo) {
              try {
                await client
                  .from("displays")
                  .update({ is_locked: false, status: "DisponÃ­vel" })
                  .eq("codigo_unico", codigoAntigo);
              } catch (err) {
                console.warn("âš ï¸ Erro ao desbloquear display antigo:", err);
              }
            }
            
            // Bloquear novo display
            try {
              await client
                .from("displays")
                .update({ 
                  is_locked: true, 
                  status: "Em uso"
                })
                .eq("codigo_unico", novoCodigo);
            } catch (err) {
              console.warn("âš ï¸ Erro ao bloquear novo display:", err);
            }
            
            // IMPORTANTE: Limpar cÃ³digo anterior ANTES de salvar o novo
            if (codigoAntigo && codigoAntigo !== novoCodigo) {
              console.log("ðŸ—‘ï¸ Limpando cÃ³digo anterior do localStorage:", codigoAntigo);
              localStorage.removeItem(CODIGO_DISPLAY_KEY);
              localStorage.removeItem(LOCAL_TELA_KEY);
              
              // Limpar cache do namespace do cÃ³digo anterior
              if (navigator.serviceWorker?.controller) {
                navigator.serviceWorker.controller.postMessage({ action: "clearNamespace" });
              }
            }
            
            // Atualizar localStorage com novo cÃ³digo
            localStorage.setItem(CODIGO_DISPLAY_KEY, novoCodigo);
            if (payload.new.local_nome) {
              localStorage.setItem(LOCAL_TELA_KEY, payload.new.local_nome);
            }
            
            // Atualizar variÃ¡vel global
            codigoAtual = novoCodigo;
            
            // Limpar cache antigo
            await resetAllCachesForNewCode();
            
            // Recarregar conteÃºdo com novo cÃ³digo
            await carregarConteudo(novoCodigo);
            
            console.log("âœ… CÃ³digo alterado e conteÃºdo recarregado");
          }
          
          // Se local_nome mudou, atualizar
          if (payload.new.local_nome && payload.new.local_nome !== payload.old?.local_nome) {
            localStorage.setItem(LOCAL_TELA_KEY, payload.new.local_nome);
            console.log("ðŸ”„ Local da tela alterado:", payload.new.local_nome);
          }
        }
      )
      .subscribe((status) => {
        if (status === 'SUBSCRIBED') {
          console.log("âœ… Realtime conectado - dispositivos (SUBSCRIBED)");
        } else if (status === 'CHANNEL_ERROR') {
          // Reduzir spam de logs - sÃ³ logar uma vez a cada 10 segundos
          const now = Date.now();
          if (!window.lastRealtimeErrorLog || (now - window.lastRealtimeErrorLog) > 10000) {
            console.warn("âš ï¸ Erro no channel de dispositivos (usando fallback de polling):", status);
            window.lastRealtimeErrorLog = now;
          }
        } else if (status !== 'TIMED_OUT') {
          // NÃ£o logar TIMED_OUT para reduzir spam
          console.log("ðŸ“¡ Status do channel de dispositivos:", status);
        }
      });
      
    console.log("ðŸ”Œ Channel de dispositivos criado");
  } catch (err) {
    // Se tabela nÃ£o existir, ignorar (retrocompatibilidade)
    if (err.message && err.message.includes('relation') && err.message.includes('does not exist')) {
      console.log("â„¹ï¸ Tabela dispositivos ainda nÃ£o criada (opcional)");
    } else {
      console.error("âŒ Erro ao criar channel de dispositivos:", err);
    }
  }
  
  // FALLBACK: VerificaÃ§Ã£o periÃ³dica caso realtime nÃ£o funcione
}

// ===== VerificaÃ§Ã£o periÃ³dica de mudanÃ§as (fallback) =====
function subscribeDeviceCommandsChannel() {
  if (deviceCommandsChannel) {
    client.removeChannel(deviceCommandsChannel);
    deviceCommandsChannel = null;
  }
  const deviceId = gerarDeviceId();
  if (!deviceId) return;
  try {
    deviceCommandsChannel = client
      .channel('realtime:device_commands')
      .on('postgres_changes', {
        event: 'INSERT',
        schema: 'public',
        table: 'device_commands',
        filter: `device_id=eq.${deviceId}`,
      }, async (payload) => {
        if (!payload.new.executed) {
          await verificarComandosDispositivo();
        }
      })
      .subscribe((status, err) => {
        if (status === 'SUBSCRIBED') {
          console.log('[realtime] device_commands conectado');
        } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
          console.warn('[realtime] device_commands falhou (' + status + '):', err?.message || err);
          setTimeout(() => { if (codigoAtual) subscribeDeviceCommandsChannel(); }, 5000);
        }
      });
  } catch (err) {
    if (!isMissingRelationError(err)) {
      console.warn('[realtime] device_commands channel error:', err);
    }
  }
}

function subscribePromoChannel() {
  if (promoChannel) {
    client.removeChannel(promoChannel);
    promoChannel = null;
  }
  try {
    promoChannel = client
      .channel('realtime:promo')
      .on('postgres_changes', {
        event: 'UPDATE',
        schema: 'public',
        table: 'promo',
      }, async () => {
        await verificarPromocaoContinuamente();
      })
      .subscribe((status, err) => {
        if (status === 'SUBSCRIBED') {
          console.log('[realtime] promo conectado');
        } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
          console.warn('[realtime] promo falhou (' + status + '):', err?.message || err);
          setTimeout(() => { if (codigoAtual) subscribePromoChannel(); }, 5000);
        }
      });
  } catch (err) {
    if (!isMissingRelationError(err)) {
      console.warn('[realtime] promo channel error:', err);
    }
  }
}

async function verificarMudancaDispositivo() {
  if (!codigoAtual || !navigator.onLine) return;
  
  try {
    const deviceId = gerarDeviceId();
    
    const { data: dispositivo, error } = await client
      .from("dispositivos")
      .select("codigo_display, local_nome")
      .eq("device_id", deviceId)
      .eq("is_ativo", true)
      .maybeSingle();
    
    if (error) {
      // Se tabela nÃ£o existir, ignorar
      if (error.message && error.message.includes('relation') && error.message.includes('does not exist')) {
        return;
      }
      console.warn("âš ï¸ Erro ao verificar dispositivo:", error);
      return;
    }
    
    if (dispositivo && dispositivo.codigo_display && dispositivo.codigo_display !== codigoAtual) {
      console.log("ðŸ”„ MudanÃ§a detectada via polling:", codigoAtual, "â†’", dispositivo.codigo_display);
      
      // Mesma lÃ³gica do realtime
      const novoCodigo = dispositivo.codigo_display;
      const codigoAntigo = codigoAtual;
      
            // Desbloquear display antigo
            if (codigoAntigo && codigoAntigo !== novoCodigo) {
              try {
                await client
                  .from("displays")
                  .update({ is_locked: false, status: "DisponÃ­vel" })
                  .eq("codigo_unico", codigoAntigo);
              } catch (err) {
                console.warn("âš ï¸ Erro ao desbloquear display antigo:", err);
              }
            }
      
      // Bloquear novo display
      try {
        await client
          .from("displays")
          .update({ 
            is_locked: true, 
            status: "Em uso"
          })
          .eq("codigo_unico", novoCodigo);
      } catch (err) {
        console.warn("âš ï¸ Erro ao bloquear novo display:", err);
      }
      
      // IMPORTANTE: Limpar cÃ³digo anterior ANTES de salvar o novo
      if (codigoAntigo && codigoAntigo !== novoCodigo) {
        console.log("ðŸ—‘ï¸ Limpando cÃ³digo anterior do localStorage:", codigoAntigo);
        localStorage.removeItem(CODIGO_DISPLAY_KEY);
        localStorage.removeItem(LOCAL_TELA_KEY);
        
        // Limpar cache do namespace do cÃ³digo anterior
        if (navigator.serviceWorker?.controller) {
          navigator.serviceWorker.controller.postMessage({ action: "clearNamespace" });
        }
      }
      
      // Atualizar localStorage com novo cÃ³digo
      localStorage.setItem(CODIGO_DISPLAY_KEY, novoCodigo);
      if (dispositivo.local_nome) {
        localStorage.setItem(LOCAL_TELA_KEY, dispositivo.local_nome);
      }
      
      // Atualizar variÃ¡vel global
      codigoAtual = novoCodigo;
      
      // Limpar cache antigo
      await resetAllCachesForNewCode();
      
      // Recarregar conteÃºdo com novo cÃ³digo
      await carregarConteudo(novoCodigo);
      
      console.log("âœ… CÃ³digo alterado via polling e conteÃºdo recarregado");
    }
  } catch (err) {
    console.warn("âš ï¸ Erro na verificaÃ§Ã£o periÃ³dica de dispositivo:", err);
  }
}

// Para exibicao mas mantem o display ativo (sem voltar pra tela de login)
// Usado quando o conteudo e removido/desatribuido — display continua de pe
async function pararExibicaoIdle() {
  await stopNativeVideoPlayback();
  for (const v of getUniqueVideoEls()) {
    try { v.pause(); v.currentTime = 0; v.removeAttribute("src"); v.load(); } catch {}
    v.style.display = "none";
  }
  if (img) {
    img.src = "";
    img.style.display = "none";
    if (img.timeoutId) { clearTimeout(img.timeoutId); delete img.timeoutId; }
  }
  destroyHls();
  stopPlaybackWatchdog();
  feedFechar();
  preloadedBufferUrl = null;
  preloadingBuffer = false;
  isLoadingVideo = false;
  isPlaying = false;
  playToken++;
  currentVideoToken++;
  currentItemUrl = null;
  activeMediaItem = null;
  activeMediaType = null;
  currentContentCode = null;
  currentPlaylistId = null;
  playlist = [];
  currentIndex = 0;
  // Limpa cache do conteudo que estava sendo exibido
  navigator.serviceWorker?.controller?.postMessage({ action: "clearNamespace" });
  try {
    if (codigoAtual) localStorage.removeItem(cacheKeyFor(codigoAtual));
    Object.keys(localStorage).forEach(k => {
      if (k.startsWith("playlist_cache_")) localStorage.removeItem(k);
    });
  } catch {}
  if (codigoAtual) await atualizarStatusCache(codigoAtual, false);
  // Tela preta — display continua com o codigo ativo, so sem conteudo
}

// ===== Cleanup/lock =====
async function pararTudoMostrarLogin() {
  // Parar e esconder vÃ­deos (ativo + buffer)
  await stopNativeVideoPlayback();
  for (const v of getUniqueVideoEls()) {
    try {
      v.pause();
      v.currentTime = 0;
      v.removeAttribute("src");
      v.load();
    } catch {}
    v.style.display = "none";
  }
  preloadedBufferUrl = null;
  preloadingBuffer = false;
  stopPlaybackWatchdog();
  pararPollScreenshot();
  feedFechar();
  if (cacheCheckTimer) { clearInterval(cacheCheckTimer); cacheCheckTimer = null; }
  isLoadingVideo = false;
  playToken++;
  currentVideoToken++;
  
  // Destruir HLS
  destroyHls();
  
  // Esconder imagem
  if (img) {
    img.src = "";
    img.style.display = "none";
    if (img.timeoutId) {
      clearTimeout(img.timeoutId);
      delete img.timeoutId;
    }
  }
  
  // Limpar status do cache no banco
  if (codigoAtual) {
    await atualizarStatusCache(codigoAtual, false);
  }

  // Limpar cache localStorage de playlist (evita conteudo stale ao reabrir)
  try {
    if (codigoAtual) localStorage.removeItem(cacheKeyFor(codigoAtual));
    if (currentContentCode) localStorage.removeItem(cacheKeyFor(currentContentCode));
    if (currentPlaylistId) localStorage.removeItem(cacheKeyFor(currentPlaylistId));
    Object.keys(localStorage).forEach(k => {
      if (k.startsWith("playlist_cache_")) localStorage.removeItem(k);
    });
  } catch {}

  // Limpar variÃ¡veis
  codigoAtual = null;
  currentPlaylistId = null;
  playlist = [];
  currentIndex = 0;
  currentItemUrl = null;
  activeMediaItem = null;
  activeMediaType = null;
  isPlaying = false;
  
  // Limpar promoÃ§Ã£o
  fecharPopupPromocao();
  
  // Mostrar tela de login (jÃ¡ faz tudo necessÃ¡rio)
  mostrarLogin();
  
  // Limpar campo (nÃ£o restaurar cÃ³digo salvo se is_locked = false)
  const codigoField = document.getElementById("codigoTela");
  if (codigoField) {
    codigoField.value = "";
    codigoField.focus();
  }
}

// ===== FunÃ§Ã£o para verificar se o player estÃ¡ ativo (nÃ£o estÃ¡ na tela de login) =====
function isPlayerAtivo() {
  const codigoInput = document.getElementById("codigoInput");
  const img = document.getElementById("imgPlayer");
  
  // Se o campo de cÃ³digo estÃ¡ visÃ­vel, o player NÃƒO estÃ¡ ativo
  if (codigoInput) {
    const estaVisivel = codigoInput.style.display !== 'none' && !codigoInput.classList.contains('fade-out');
    if (estaVisivel) {
      return false;
    }
  }
  
  // Se vÃ­deo ou imagem estÃ£o visÃ­veis, o player estÃ¡ ativo
  for (const v of getUniqueVideoEls()) {
    if (v && v.style.display !== 'none') return true;
  }
  if (img && img.style.display !== 'none') {
    return true;
  }
  
  return false;
}

// ===== FunÃ§Ã£o AGRESSIVA para entrar em fullscreen automÃ¡tico =====
let fullscreenInterval = null;
let isFullscreenActive = false;

// Verificar se jÃ¡ estÃ¡ em fullscreen
function isFullscreen() {
  return !!(document.fullscreenElement || 
            document.webkitFullscreenElement || 
            document.mozFullScreenElement || 
            document.msFullscreenElement ||
            (window.innerHeight === screen.height && window.innerWidth === screen.width));
}

// FunÃ§Ã£o para tentar fullscreen em um elemento especÃ­fico
function tryFullscreenOnElement(element) {
  if (!element) return false;
  
  try {
    // PadrÃ£o (Chrome, Firefox, Edge moderno)
    if (element.requestFullscreen) {
      element.requestFullscreen().catch(() => {});
      return true;
    }
    // WebKit (Safari, Chrome antigo)
    if (element.webkitRequestFullscreen) {
      element.webkitRequestFullscreen();
      return true;
    }
    // Mozilla (Firefox antigo)
    if (element.mozRequestFullScreen) {
      element.mozRequestFullScreen();
      return true;
    }
    // IE/Edge antigo
    if (element.msRequestFullscreen) {
      element.msRequestFullscreen();
      return true;
    }
  } catch (e) {
    // Ignorar erros silenciosamente
  }
  
  return false;
}

// FunÃ§Ã£o principal para forÃ§ar fullscreen
function entrarFullscreen() {
  // Verificar se jÃ¡ estÃ¡ em fullscreen
  if (isFullscreen()) {
    isFullscreenActive = true;
    return;
  }
  
  // Verificar se hÃ¡ cÃ³digo E local salvos - se sim, FORÃ‡AR fullscreen
  const codigoSalvo = localStorage.getItem(CODIGO_DISPLAY_KEY);
  const localSalvo = localStorage.getItem(LOCAL_TELA_KEY);
  const temCodigoCompleto = codigoSalvo && codigoSalvo.trim() && localSalvo && localSalvo.trim();
  
  // Se nÃ£o tem cÃ³digo completo, nÃ£o forÃ§ar
  if (!temCodigoCompleto) {
    return;
  }
  
  // Verificar se Ã© PWA instalado (tem mais permissÃµes)
  const isPWA = window.matchMedia('(display-mode: standalone)').matches || 
                window.navigator.standalone === true ||
                document.referrer.includes('android-app://');
  
  // Lista de elementos para tentar fullscreen (em ordem de prioridade)
  const elementsToTry = [
    document.documentElement,  // HTML (padrÃ£o)
    document.body,              // Body (funciona em alguns navegadores)
  ];
  
  // Adicionar elementos de mÃ­dia se existirem
  const video = document.getElementById("videoPlayer");
  const videoB = document.getElementById("videoPlayerB");
  const img = document.getElementById("imgPlayer");
  if (video && video.style.display !== 'none') {
    elementsToTry.push(video);
  }
  if (videoB && videoB.style.display !== 'none') {
    elementsToTry.push(videoB);
  }
  if (img && img.style.display !== 'none') {
    elementsToTry.push(img);
  }
  
  // Tentar fullscreen em TODOS os elementos
  let attempted = false;
  for (const elem of elementsToTry) {
    if (tryFullscreenOnElement(elem)) {
      attempted = true;
      // NÃ£o parar aqui, tentar em todos para mÃ¡xima compatibilidade
    }
  }
  
  // Se Ã© PWA, tentar ainda mais agressivamente
  if (isPWA && !attempted) {
    // Tentar com diferentes mÃ©todos especÃ­ficos para PWA
    setTimeout(() => {
      tryFullscreenOnElement(document.documentElement);
      tryFullscreenOnElement(document.body);
    }, 50);
  }
  
  // Iniciar monitoramento contÃ­nuo se ainda nÃ£o estiver ativo
  if (!fullscreenInterval) {
    startFullscreenMonitoring();
  }
}

// Monitoramento contÃ­nuo para reativar fullscreen se sair
function startFullscreenMonitoring() {
  if (fullscreenInterval) return;
  
  fullscreenInterval = setInterval(() => {
    const codigoSalvo = localStorage.getItem(CODIGO_DISPLAY_KEY);
    const localSalvo = localStorage.getItem(LOCAL_TELA_KEY);
    const temCodigoCompleto = codigoSalvo && codigoSalvo.trim() && localSalvo && localSalvo.trim();
    
    // SÃ³ monitorar se tiver cÃ³digo completo E player estiver ativo
    if (!temCodigoCompleto || !isPlayerAtivo()) {
      stopFullscreenMonitoring();
      return;
    }
    
    // Verificar se saiu do fullscreen
    if (!isFullscreen()) {
      isFullscreenActive = false;
      // Tentar reativar imediatamente
      entrarFullscreen();
    } else {
      isFullscreenActive = true;
    }
  }, 1000); // Verificar a cada 1 segundo
}

// Parar monitoramento
function stopFullscreenMonitoring() {
  if (fullscreenInterval) {
    clearInterval(fullscreenInterval);
    fullscreenInterval = null;
  }
  isFullscreenActive = false;
}

function mostrarLogin() {
  setPlayerMode("login");

  // Parar monitoramento de fullscreen
  stopFullscreenMonitoring();
  
  // Sair do fullscreen se estiver em fullscreen
  if (document.fullscreenElement || document.webkitFullscreenElement) {
    if (document.exitFullscreen) {
      document.exitFullscreen().catch(() => {});
    } else if (document.webkitExitFullscreen) {
      document.webkitExitFullscreen();
    } else if (document.mozCancelFullScreen) {
      document.mozCancelFullScreen();
    } else if (document.msExitFullscreen) {
      document.msExitFullscreen();
    }
  }
  
  // Garantir que vÃ­deos e imagem estejam escondidos e com z-index baixo
  const img = document.getElementById("imgPlayer");
  for (const v of getUniqueVideoEls()) {
    try {
      v.pause();
      v.currentTime = 0;
      revokeElementObjectUrl(v);
      v.removeAttribute("src");
      v.load();
    } catch {}
    v.style.display = "none";
    v.style.zIndex = "-1";
    v.style.opacity = "0";
    v.style.visibility = "hidden";
    v.classList.remove("hidden-ready");
  }
  if (img) {
    img.src = "";
    img.removeAttribute("src");
    img.classList.remove("hidden-ready");
    img.style.display = "none";
    img.style.zIndex = "-1";
    img.style.opacity = "0";
    img.style.visibility = "hidden";
  }
  
  // Aguardar um pouco para garantir que fullscreen saiu
  setTimeout(() => {
    // Mostrar elementos de login com z-index alto
    const codigoInput = document.getElementById("codigoInput");
    const rodape = document.getElementById("rodape");
    const logo = document.getElementById("logo");
    
    if (codigoInput) {
      codigoInput.style.display = "flex";
      codigoInput.style.opacity = "1";
      codigoInput.style.zIndex = "100";
      codigoInput.style.visibility = "visible";
      codigoInput.style.position = "relative";
      codigoInput.classList.remove("fade-out");
    }
    
    if (rodape) {
      rodape.style.display = "block";
      rodape.style.opacity = "1";
      rodape.style.zIndex = "100";
      rodape.style.visibility = "visible";
      rodape.classList.remove("fade-out");
    }
    
    if (logo) {
      logo.style.display = "block";
      logo.style.opacity = "1";
      logo.style.zIndex = "100";
      logo.style.visibility = "visible";
      logo.classList.remove("fade-out");
    }
    
    // Garantir que o body tenha background visÃ­vel
    document.body.style.backgroundColor = "#000";
    document.body.style.overflow = "auto"; // Permitir scroll se necessÃ¡rio
  }, 100);
}

async function checarLockEConteudo() {
  if (!codigoAtual || !navigator.onLine) return;
  try {
    const deviceId = gerarDeviceId();
    
    // Buscar com device_id para verificar se Ã© o mesmo dispositivo
    let { data, error } = await client
      .from("displays")
      .select("is_locked,codigo_conteudoAtual,device_id,orientacao")
      .eq("codigo_unico", codigoAtual)
      .maybeSingle();
    
    // Se nÃ£o encontrou device_id, tentar sem ele (retrocompatibilidade)
    if (error && error.message && error.message.includes('column') && error.message.includes('does not exist')) {
      const { data: dataBasica } = await client
        .from("displays")
        .select("is_locked,codigo_conteudoAtual")
        .eq("codigo_unico", codigoAtual)
        .maybeSingle();
      data = dataBasica;
    }

    if (!data) return;

    // Verificar se Ã© o mesmo dispositivo
    const mesmoDispositivo = data.device_id && data.device_id === deviceId;
    
    // Se is_locked = false, significa que exibiÃ§Ã£o foi parada
    // Limpar tudo e nÃ£o continuar (independente de ser o mesmo dispositivo)
    if (data.is_locked === false) {
      console.log("â¸ï¸ Display desbloqueado na verificaÃ§Ã£o periÃ³dica (is_locked = false), parando exibiÃ§Ã£o...");
      
      // Desativar dispositivo
      await client
        .from("dispositivos")
        .update({ is_ativo: false })
        .eq("device_id", deviceId);
      
      // Limpar localStorage
      localStorage.removeItem(CODIGO_DISPLAY_KEY);
      localStorage.removeItem(LOCAL_TELA_KEY);
      
      // Limpar cache do namespace antes de sair
      navigator.serviceWorker.controller?.postMessage({ action: "clearNamespace" });
      
      // Parar tudo e mostrar tela de login
      await pararTudoMostrarLogin();
      return;
    }

    const orientationChanged = applyDisplayOrientationSetting(data.orientacao);

    if (data.codigo_conteudoAtual && data.codigo_conteudoAtual !== currentContentCode) {
      // Invalida cache para forcar reload do banco
      localStorage.removeItem(cacheKeyFor(data.codigo_conteudoAtual));
      localStorage.removeItem(cacheKeyFor(codigoAtual));
      if (currentContentCode) localStorage.removeItem(cacheKeyFor(currentContentCode));
      await carregarConteudo(data.codigo_conteudoAtual);
    } else if (!data.codigo_conteudoAtual && currentContentCode) {
      await pararExibicaoIdle();
      return;
    } else if (orientationChanged && currentContentCode) {
      await carregarConteudo(currentContentCode);
    }

    // Verificar promoÃ§Ã£o continuamente
    await verificarPromocaoContinuamente();
    
    // Verificar comandos device_commands
    await verificarComandosDispositivo();
  } catch {}
}

// ===== Verificar comandos do dispositivo =====
async function verificarComandosDispositivo() {
  if (!navigator.onLine || !codigoAtual) return;
  
  try {
    const deviceId = gerarDeviceId();
    
    // Buscar comandos pendentes para este dispositivo
    const { data: comandos, error } = await client
      .from("device_commands")
      .select("id, command, executed")
      .eq("device_id", deviceId)
      .eq("executed", false)
      .order("created_at", { ascending: true })
      .limit(10);
    
    if (error) {
      // Se tabela nÃ£o existir, ignorar (retrocompatibilidade)
      if (error.message && error.message.includes('relation') && error.message.includes('does not exist')) {
        return;
      }
      console.warn("âš ï¸ Erro ao verificar comandos:", error);
      return;
    }
    
    if (!comandos || comandos.length === 0) return;
    
    // Processar cada comando
    for (const comando of comandos) {
      try {
        const commandName = String(comando.command || "").trim().toLowerCase();
        console.log("ðŸ“¨ Processando comando:", commandName, "para device:", deviceId);

        const marcarComandoExecutado = async () => {
          const payload = {
            executed: true,
            executed_at: new Date().toISOString(),
          };

          let { error: updateError } = await client
            .from("device_commands")
            .update(payload)
            .eq("id", comando.id);

          if (updateError && isMissingColumnError(updateError, "executed_at")) {
            const fallback = await client
              .from("device_commands")
              .update({ executed: true })
              .eq("id", comando.id);
            updateError = fallback.error;
          }

          if (updateError && !isMissingRelationError(updateError)) {
            throw updateError;
          }
        };
        
        if (commandName === 'restart_app' || commandName === 'restart' || commandName === 'reload_app') {
          // Marcar como restart antes de recarregar
          sessionStorage.setItem(RESTARTING_KEY, 'true');
          
          // Marcar comando como executado
          await marcarComandoExecutado();
          
          console.log("ðŸ”„ Reiniciando app...");
          
          // Aguardar um pouco para garantir que o sessionStorage foi salvo
          setTimeout(() => {
            try {
              location.reload();
            } catch {
              window.location.replace(window.location.href);
            }
          }, 500);
          
          return; // Sair apÃ³s processar restart
        } else if (commandName === 'clear_cache' || commandName === 'clean_cache') {
          await marcarComandoExecutado();

          console.log("🧹 Limpando cache remotamente e recarregando conteúdo...");
          await limparCacheAtualEReload();
          return;
        } else {
          // Outros comandos podem ser adicionados aqui
          console.log("â„¹ï¸ Comando nÃ£o implementado:", commandName);
          
          // Marcar como executado mesmo assim (para nÃ£o ficar pendente)
          await marcarComandoExecutado();
        }
      } catch (err) {
        console.error("âŒ Erro ao processar comando:", err);
      }
    }
  } catch (err) {
    console.warn("âš ï¸ Erro ao verificar comandos do dispositivo:", err);
  }
}

async function enviarHeartbeatOnline() {
  if (!codigoAtual || !navigator.onLine) return;

  const deviceId = gerarDeviceId();
  const nowIso = new Date().toISOString();

  try {
    const updateData = {
      status_tela: "Online",
      last_ping: nowIso
    };

    try {
      updateData.device_id = deviceId;
      updateData.device_last_seen = nowIso;
    } catch {}

    await client
      .from("displays")
      .update(updateData)
      .eq("codigo_unico", codigoAtual);
  } catch (err) {
    if (isMissingColumnError(err)) {
      try {
        await client
          .from("displays")
          .update({
            status_tela: "Online",
            last_ping: nowIso
          })
          .eq("codigo_unico", codigoAtual);
      } catch {}
    }
  }

  try {
    const { error: dispositivoHeartbeatError } = await client
      .from("dispositivos")
      .update({
        last_seen: nowIso,
        is_ativo: true,
        local_nome: localStorage.getItem(LOCAL_TELA_KEY) || codigoAtual
      })
      .eq("device_id", deviceId)
      .eq("codigo_display", codigoAtual);

    if (dispositivoHeartbeatError && !isMissingRelationError(dispositivoHeartbeatError) && !isMissingColumnError(dispositivoHeartbeatError, "last_seen")) {
      console.warn("⚠️ Erro ao atualizar heartbeat do dispositivo:", dispositivoHeartbeatError);
    }
  } catch (err) {
    if (!isMissingRelationError(err) && !isMissingColumnError(err, "last_seen")) {
      console.warn("⚠️ Erro ao enviar heartbeat imediato:", err);
    }
  }
}

async function tentarRecuperarDispositivoNoServidor() {
  if (!codigoAtual || !navigator.onLine) return false;

  try {
    const deviceId = gerarDeviceId();
    const localNome = localStorage.getItem(LOCAL_TELA_KEY) || codigoAtual;
    const payload = {
      codigo_display: codigoAtual,
      local_nome: localNome,
      last_seen: new Date().toISOString(),
      is_ativo: true
    };

    const { data: dispositivoExistente, error: selectError } = await client
      .from("dispositivos")
      .select("id")
      .eq("device_id", deviceId)
      .maybeSingle();

    if (selectError) {
      if (isMissingRelationError(selectError)) return false;
      throw selectError;
    }

    if (dispositivoExistente) {
      const { error: updateError } = await client
        .from("dispositivos")
        .update(payload)
        .eq("device_id", deviceId);
      if (updateError && !isMissingRelationError(updateError)) throw updateError;
    } else {
      const { error: insertError } = await client
        .from("dispositivos")
        .insert({
          device_id: deviceId,
          ...payload
        });
      if (insertError && !isMissingRelationError(insertError)) throw insertError;
    }

    awaitingServerRecovery = false;
    return true;
  } catch (err) {
    console.warn("⚠️ Falha ao recuperar dispositivo no servidor:", err?.message || err);
    return false;
  }
}

// ===== Service Worker =====
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('service-worker.js')
    .then(async (registration) => {
      console.log('âœ… Service Worker registrado:', registration.scope);
      await navigator.serviceWorker.ready;
      console.log('âœ… Service Worker pronto para uso');
      
      navigator.serviceWorker.addEventListener('message', event => {
        if (event.data.action === "checkItem") {
          const isValid = playlist.some(item =>
            item.url === event.data.url ||
            item.urlPortrait === event.data.url ||
            item.urlLandscape === event.data.url
          );
          event.ports[0].postMessage({ valid: isValid });
        } else if (event.data.action === "cacheUpdated") {
          console.log("ðŸ“¦ Cache atualizado pelo Service Worker");
          // Atualizar status do cache no banco
          if (codigoAtual) {
            atualizarStatusCache(codigoAtual, true);
            agendarVerificacaoIntegridade();
          }
        }
      });
    })
    .catch((error) => {
      console.error('âŒ Erro ao registrar Service Worker:', error);
    });
} else {
  console.warn('âš ï¸ Service Worker nÃ£o suportado neste navegador');
}

// ===== UI Events / Heartbeat / Unlock =====

// Debounce do evento online
window.addEventListener("online", () => {
  if (onlineDebounceId) clearTimeout(onlineDebounceId);
  onlineDebounceId = setTimeout(async () => {
    if (codigoAtual) {
      try {
        const deviceId = gerarDeviceId();
        await tentarRecuperarDispositivoNoServidor();
        
        // Buscar com device_id para verificar se Ã© o mesmo dispositivo
        let { data, error } = await client
          .from("displays")
          .select("is_locked,device_id")
          .eq("codigo_unico", codigoAtual)
          .maybeSingle();
        
        // Se nÃ£o encontrou device_id, tentar sem ele (retrocompatibilidade)
        if (error && error.message && error.message.includes('column') && error.message.includes('does not exist')) {
          const { data: dataBasica } = await client
            .from("displays")
            .select("is_locked")
            .eq("codigo_unico", codigoAtual)
            .maybeSingle();
          data = dataBasica;
        }

        if (data) {
          const mesmoDispositivo = data.device_id && data.device_id === deviceId;
          
          // Se is_locked = false, significa que exibiÃ§Ã£o foi parada - limpar tudo
          if (data.is_locked === false) {
            console.log("â¸ï¸ Display desbloqueado ao voltar online (is_locked = false), parando exibiÃ§Ã£o...");
            
            // Desativar dispositivo
            await client
              .from("dispositivos")
              .update({ is_ativo: false })
              .eq("device_id", deviceId);
            
            // Limpar localStorage
            localStorage.removeItem(CODIGO_DISPLAY_KEY);
            localStorage.removeItem(LOCAL_TELA_KEY);
            
            // Parar tudo e mostrar tela de login
            await pararTudoMostrarLogin();
            return;
          }
          
          // Se estÃ¡ locked e Ã© o mesmo dispositivo, garantir lock
          if (mesmoDispositivo) {
            const updateData = { 
              is_locked: true, 
              status: "Em uso",
              device_id: deviceId,
              device_last_seen: new Date().toISOString()
            };
            
            try {
              await client
                .from("displays")
                .update(updateData)
                .eq("codigo_unico", codigoAtual);
            } catch (updateErr) {
              // Se campos nÃ£o existirem, fazer update sem eles
              if (updateErr.message && updateErr.message.includes('column') && updateErr.message.includes('does not exist')) {
                await client
                  .from("displays")
                  .update({ is_locked: true, status: "Em uso" })
                  .eq("codigo_unico", codigoAtual);
              }
            }

            await enviarHeartbeatOnline();
          }
        }
      } catch {}
    }

    if (!realtimeReady) {
      iniciarRealtime();
      realtimeReady = true;
    }

    if (codigoAtual) {
      const alvoSync = currentPlaylistId || currentContentCode || codigoAtual;

      if (awaitingServerRecovery || pendingResync || !isPlaying) {
        pendingResync = false;
        await carregarConteudo(alvoSync);
        if (!isPlaying && playlist.length > 0) {
          tocarLoop();
        }
      } else {
        pendingResync = true;
      }
    }
  }, 1200);
});

setInterval(async () => {
  if (codigoAtual && navigator.onLine) {
    await enviarHeartbeatOnline();
  }
}, 5 * 60 * 1000);

window.addEventListener("beforeunload", () => {
  if (!codigoAtual) return;

  // Verificar se Ã© um restart (nÃ£o limpar dados se for restart)
  const isRestarting = sessionStorage.getItem(RESTARTING_KEY) === 'true';
  
  if (isRestarting) {
    console.log("ðŸ”„ Reiniciando app - mantendo dados salvos");
    // NÃ£o limpar localStorage - manter cÃ³digo salvo para reconexÃ£o
    // NÃ£o desbloquear display - manter locked para o mesmo dispositivo
    // Apenas limpar flag de restart
    sessionStorage.removeItem(RESTARTING_KEY);
    return;
  }

  // Fechar o app nao deve invalidar o pareamento local nem o cache.
  // Isso preserva a retomada apos reboot e a inicializacao sem internet.
  console.log("Fechando app - mantendo codigo e cache local para retomada");
});

// ===== Debug Helper =====
function debugVideoState() {
  console.log('ðŸ” Estado atual do vÃ­deo:', {
    isLoadingVideo,
    currentVideoToken,
    isPlaying,
    videoSrc: video.src,
    videoReadyState: video.readyState,
    videoNetworkState: video.networkState,
    videoPaused: video.paused
  });
}

// ===== FunÃ§Ãµes de PromoÃ§Ã£o =====
async function verificarPromocao() {
  if (!codigoAtual) return;
  
  try {
    console.log("ðŸ” Verificando promoÃ§Ã£o para cÃ³digo:", codigoAtual);
    
    const { data: display, error: displayError } = await client
      .from("displays")
      .select("promo, id_promo")
      .eq("codigo_unico", codigoAtual)
      .single();

    if (displayError) {
      console.error("Erro ao buscar display:", displayError);
      return;
    }

    console.log("ðŸ“Š Dados do display:", display);

    if (!display || !display.promo || !display.id_promo) {
      console.log("âŒ Nenhuma promoÃ§Ã£o ativa para esta tela");
      return;
    }

    console.log("ðŸ” Buscando promoÃ§Ã£o com id_promo:", display.id_promo);

    const { data: promocao, error: promoError } = await client
      .from("promo")
      .select("*")
      .eq("id_promo", display.id_promo)
      .single();

    if (promoError) {
      console.error("Erro ao buscar promoÃ§Ã£o:", promoError);
      return;
    }

    console.log("ðŸŽ¯ Dados da promoÃ§Ã£o:", promocao);

    if (!promocao) {
      console.log("âŒ PromoÃ§Ã£o nÃ£o encontrada");
      return;
    }

    promoData = promocao;
    promoCounter = promocao.contador || 0;
    
    console.log("â° Contador da promoÃ§Ã£o:", promoCounter);
    
    if (promoCounter <= 0) {
      console.log("â° Contador zerado, desativando promoÃ§Ã£o");
      await desativarPromocao();
      return;
    }

    console.log("âœ… Exibindo popup de promoÃ§Ã£o");
    mostrarPopupPromocao();
  } catch (err) {
    console.error("Erro ao verificar promoÃ§Ã£o:", err);
  }
}

function mostrarPopupPromocao() {
  if (promoPopup) {
    promoPopup.remove();
  }

  const popup = document.createElement('div');
  popup.id = 'promoPopup';
  popup.style.cssText = `
    position: fixed;
    top: 0;
    left: 0;
    width: 100vw;
    height: 100vh;
    background: rgba(0, 0, 0, 0.8);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 99999;
    padding: 20px;
    box-sizing: border-box;
  `;

  const modal = document.createElement('div');
  modal.style.cssText = `
    background: white;
    border-radius: 16px;
    max-width: 90vw;
    max-height: 90vh;
    width: 100%;
    max-width: 500px;
    overflow: hidden;
    box-shadow: 0 20px 40px rgba(0, 0, 0, 0.3);
    animation: popupFadeIn 0.5s ease-out, popupBounce 0.8s ease-out 0.3s both, popupPulse 3s ease-in-out infinite 1.5s;
    border: 3px solid #8B5CF6;
  `;

  // Header com gradiente
  const header = document.createElement('div');
  header.style.cssText = `
    background: linear-gradient(135deg, #8B5CF6 0%, #A78BFA 100%);
    padding: 25px;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 15px;
  `;

  const lightningIcon = document.createElement('div');
  lightningIcon.textContent = '\u26A1';
  lightningIcon.style.cssText = `
    font-size: 32px;
    color: #FCD34D;
    text-shadow: 0 0 10px rgba(252, 211, 77, 0.5);
    animation: pulse 2s infinite;
  `;

  const headerText = document.createElement('div');
  headerText.textContent = 'OFERTA REL\u00C2MPAGO';
  headerText.style.cssText = `
    color: white;
    font-weight: 900;
    font-size: 22px;
    letter-spacing: 2px;
    text-shadow: 0 2px 4px rgba(0, 0, 0, 0.3);
    text-transform: uppercase;
  `;

  header.appendChild(lightningIcon);
  header.appendChild(headerText);

  // ConteÃºdo principal
  const content = document.createElement('div');
  content.style.cssText = `
    padding: 30px;
    text-align: center;
  `;

  // Imagem da promoÃ§Ã£o (dentro da Ã¡rea branca do popup)
  const imageContainer = document.createElement('div');
  imageContainer.style.cssText = `
    margin-bottom: 15px;
    margin-top: 10px;
    display: flex;
    justify-content: center;
    align-items: center;
    width: 100%;
    position: relative;
  `;

  if (promoData.imagem_promo) {
    const promoImage = document.createElement('img');
    promoImage.src = promoData.imagem_promo;
    promoImage.style.cssText = `
      max-width: 100%;
      max-height: 120px;
      width: auto;
      height: auto;
      border-radius: 8px;
      object-fit: contain;
      display: block;
      position: relative;
      z-index: 1;
    `;
    imageContainer.appendChild(promoImage);
  } else {
    const noImageText = document.createElement('div');
    noImageText.textContent = 'Nenhuma imagem configurada';
    noImageText.style.cssText = `
      color: #9CA3AF;
      font-size: 14px;
      margin-bottom: 10px;
    `;
    const placeholder = document.createElement('div');
    placeholder.style.cssText = `
      width: 180px;
      height: 100px;
      background: #F3F4F6;
      border-radius: 8px;
      border: 2px dashed #D1D5DB;
      position: relative;
      z-index: 1;
    `;
    imageContainer.appendChild(noImageText);
    imageContainer.appendChild(placeholder);
  }

  // Texto da promoÃ§Ã£o
  const promoText = document.createElement('div');
  promoText.id = 'promoText';
  promoText.textContent = promoData.texto_promo || 'Promo\u00E7\u00E3o especial';
  promoText.style.cssText = `
    font-size: 24px;
    color: #374151;
    margin-bottom: 25px;
    font-weight: 700;
    line-height: 1.3;
    text-align: center;
    animation: textGlow 3s ease-in-out infinite alternate;
  `;

  // PreÃ§o original (riscado)
  const originalPrice = document.createElement('div');
  originalPrice.id = 'promoOriginalPrice';
  originalPrice.textContent = `R$ ${formatarValorMonetario(promoData.valor_antes) || '200,00'}`;
  originalPrice.style.cssText = `
    font-size: 18px;
    color: #EF4444;
    text-decoration: line-through;
    font-weight: bold;
    margin-bottom: 8px;
  `;

  // "POR APENAS"
  const porApenas = document.createElement('div');
  porApenas.textContent = 'POR APENAS';
  porApenas.style.cssText = `
    font-size: 16px;
    color: #000;
    font-weight: bold;
    letter-spacing: 2px;
    margin-bottom: 8px;
    position: relative;
    overflow: hidden;
    animation: shimmer 2.5s ease-in-out infinite;
  `;

  // PreÃ§o promocional
  const promoPrice = document.createElement('div');
  promoPrice.id = 'promoPrice';
  promoPrice.textContent = `R$ ${formatarValorMonetario(promoData.valor_promo) || '99,90'}`;
  promoPrice.style.cssText = `
    font-size: 42px;
    color: #DC2626;
    font-weight: 900;
    margin-bottom: 20px;
    text-shadow: 0 2px 4px rgba(220, 38, 38, 0.3);
    animation: pricePulse 2s ease-in-out infinite;
    transform-origin: center;
  `;

  // Linha separadora
  const separator = document.createElement('div');
  separator.style.cssText = `
    width: 100%;
    height: 3px;
    background: #FCD34D;
    margin-bottom: 20px;
  `;

  // Contador de unidades
  const counterContainer = document.createElement('div');
  counterContainer.style.cssText = `
    background: linear-gradient(135deg, #8B5CF6 0%, #A78BFA 100%);
    padding: 20px;
    border-radius: 12px;
    color: white;
  `;

  const ultimasUnidades = document.createElement('div');
  ultimasUnidades.textContent = '\u00DALTIMAS UNIDADES';
  ultimasUnidades.style.cssText = `
    font-size: 14px;
    font-weight: bold;
    letter-spacing: 1px;
    margin-bottom: 8px;
  `;

  const counter = document.createElement('div');
  counter.id = 'promoCounter';
  counter.textContent = promoCounter;
  counter.style.cssText = `
    font-size: 48px;
    font-weight: bold;
    animation: counterBlink 1.5s ease-in-out infinite;
    text-shadow: 0 0 10px rgba(255, 255, 255, 0.5);
  `;

  counterContainer.appendChild(ultimasUnidades);
  counterContainer.appendChild(counter);

  // Montar o modal (imagem dentro da Ã¡rea branca, entre header e texto)
  content.appendChild(imageContainer);
  content.appendChild(promoText);
  content.appendChild(originalPrice);
  content.appendChild(porApenas);
  content.appendChild(promoPrice);
  content.appendChild(separator);
  content.appendChild(counterContainer);

  modal.appendChild(header);
  modal.appendChild(content);
  popup.appendChild(modal);
  document.body.appendChild(popup);

  promoPopup = popup;

  // Adicionar animaÃ§Ã£o CSS
  const style = document.createElement('style');
  style.textContent = `
    @keyframes popupFadeIn {
      from { opacity: 0; transform: scale(0.9) translateY(-20px); }
      to { opacity: 1; transform: scale(1) translateY(0); }
    }
    @keyframes popupBounce {
      0% { transform: scale(0.8) translateY(-30px); }
      50% { transform: scale(1.05) translateY(5px); }
      100% { transform: scale(1) translateY(0); }
    }
    @keyframes popupPulse {
      0%, 100% { 
        transform: scale(1); 
        box-shadow: 0 20px 40px rgba(0, 0, 0, 0.3), 0 0 0 0 rgba(139, 92, 246, 0.4);
      }
      50% { 
        transform: scale(1.02); 
        box-shadow: 0 25px 50px rgba(0, 0, 0, 0.4), 0 0 30px rgba(139, 92, 246, 0.6);
      }
    }
    @keyframes pulse {
      0%, 100% { transform: scale(1); }
      50% { transform: scale(1.1); }
    }
    @keyframes textGlow {
      0% { text-shadow: 0 0 5px rgba(139, 92, 246, 0.3); }
      100% { text-shadow: 0 0 15px rgba(139, 92, 246, 0.6), 0 0 25px rgba(139, 92, 246, 0.3); }
    }
    @keyframes pricePulse {
      0%, 100% { transform: scale(1); color: #DC2626; }
      50% { transform: scale(1.05); color: #EF4444; }
    }
    @keyframes counterBlink {
      0%, 100% { opacity: 1; transform: scale(1); }
      50% { opacity: 0.7; transform: scale(1.1); }
    }
    @keyframes shimmer {
      0% {
        background: linear-gradient(90deg, transparent, transparent, transparent);
        background-size: 200% 100%;
        background-position: -200% 0;
      }
      50% {
        background: linear-gradient(90deg, transparent, rgba(255, 255, 255, 0.8), transparent);
        background-size: 200% 100%;
        background-position: 200% 0;
      }
      100% {
        background: linear-gradient(90deg, transparent, transparent, transparent);
        background-size: 200% 100%;
        background-position: 200% 0;
      }
    }
  `;
  document.head.appendChild(style);
}

// FunÃ§Ã£o para verificar promoÃ§Ã£o continuamente (sem causar piscar)
async function verificarPromocaoContinuamente() {
  if (!codigoAtual) return;
  
  try {
    const { data: display, error: displayError } = await client
      .from("displays")
      .select("promo, id_promo")
      .eq("codigo_unico", codigoAtual)
      .single();

    if (displayError) {
      console.error("Erro ao buscar display:", displayError);
      return;
    }

    // Se nÃ£o hÃ¡ promoÃ§Ã£o ativa e popup estÃ¡ aberto, fechar
    if (!display || !display.promo || !display.id_promo) {
      if (promoPopup) {
        console.log("ðŸ”„ PromoÃ§Ã£o desativada, fechando popup");
        fecharPopupPromocao();
      }
      return;
    }

    // Se hÃ¡ promoÃ§Ã£o ativa e popup nÃ£o estÃ¡ aberto, abrir
    if (!promoPopup) {
      console.log("ðŸ”„ PromoÃ§Ã£o ativada, abrindo popup");
      await verificarPromocao();
    } else {
      // Se popup estÃ¡ aberto, verificar se contador mudou no banco
      await verificarContadorNoBanco(display.id_promo);
    }
  } catch (err) {
    console.error("Erro ao verificar promoÃ§Ã£o continuamente:", err);
  }
}

// FunÃ§Ã£o para verificar mudanÃ§as no contador no banco
async function verificarContadorNoBanco(idPromo) {
  try {
    const { data: promocao, error: promoError } = await client
      .from("promo")
      .select("contador, texto_promo, valor_antes, valor_promo")
      .eq("id_promo", idPromo)
      .single();

    if (promoError) {
      console.error("Erro ao buscar contador:", promoError);
      return;
    }

    if (promocao) {
      // Verificar se contador mudou
      if (promocao.contador !== promoCounter) {
        console.log(`ðŸ”„ Contador mudou no banco: ${promoCounter} â†’ ${promocao.contador}`);
        atualizarContadorPromocao(promocao.contador);
      }
      
      // Verificar se dados da promo mudaram e atualizar
      atualizarDadosPromocao(promocao);
    }
  } catch (err) {
    console.error("Erro ao verificar contador no banco:", err);
  }
}

// FunÃ§Ã£o para formatar valores monetÃ¡rios
function formatarValorMonetario(valor) {
  if (!valor) return '0,00';
  
  // Se o valor jÃ¡ tem vÃ­rgula, usar como estÃ¡
  if (valor.toString().includes(',')) {
    return valor.toString();
  }
  
  const numero = parseFloat(valor);
  
  // Se o valor Ã© muito grande (provavelmente em centavos), dividir por 100
  if (numero >= 100 && Number.isInteger(numero)) {
    const valorEmReais = numero / 100;
    return valorEmReais.toLocaleString('pt-BR', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2
    });
  }
  
  // Se o valor Ã© menor que 100, tratar como reais
  if (numero < 100) {
    return numero.toLocaleString('pt-BR', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2
    });
  }
  
  // Para valores decimais, formatar normalmente
  return numero.toLocaleString('pt-BR', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  });
}

// FunÃ§Ã£o para atualizar contador dinamicamente
function atualizarContadorPromocao(novoValor) {
  promoCounter = novoValor;
  
  const counterElement = document.getElementById('promoCounter');
  if (counterElement) {
    counterElement.textContent = promoCounter;
  }
  
  // Se contador chegar a zero, desativar promoÃ§Ã£o
  if (promoCounter <= 0) {
    desativarPromocao();
  }
}

// FunÃ§Ã£o para atualizar dados da promoÃ§Ã£o em tempo real
function atualizarDadosPromocao(promocao) {
  // Atualizar texto da promoÃ§Ã£o
  const promoTextElement = document.getElementById('promoText');
  if (promoTextElement && promocao.texto_promo) {
    promoTextElement.textContent = promocao.texto_promo;
  }
  
  // Atualizar preÃ§o original
  const originalPriceElement = document.getElementById('promoOriginalPrice');
  if (originalPriceElement && promocao.valor_antes) {
    originalPriceElement.textContent = `R$ ${formatarValorMonetario(promocao.valor_antes)}`;
  }
  
  // Atualizar preÃ§o promocional
  const promoPriceElement = document.getElementById('promoPrice');
  if (promoPriceElement && promocao.valor_promo) {
    promoPriceElement.textContent = `R$ ${formatarValorMonetario(promocao.valor_promo)}`;
  }
}

async function desativarPromocao() {
  try {
    console.log("ðŸ”„ Desativando promoÃ§Ã£o...");
    
    // Atualizar display: promo = false, id_promo = null
    const { error: updateError } = await client
      .from("displays")
      .update({ promo: false, id_promo: null })
      .eq("codigo_unico", codigoAtual);

    if (updateError) {
      console.error("Erro ao atualizar display:", updateError);
    }

    // Deletar linha da tabela promo
    if (promoData && promoData.id_promo) {
      const { error: deleteError } = await client
        .from("promo")
        .delete()
        .eq("id_promo", promoData.id_promo);
        
      if (deleteError) {
        console.error("Erro ao deletar promoÃ§Ã£o:", deleteError);
      }
    }

    console.log("âœ… PromoÃ§Ã£o desativada com sucesso");
    fecharPopupPromocao();
  } catch (err) {
    console.error("Erro ao desativar promoÃ§Ã£o:", err);
  }
}

function fecharPopupPromocao() {
  if (promoPopup) {
    promoPopup.remove();
    promoPopup = null;
  }

  promoData = null;
  promoCounter = null;
}

// ===== Helpers de Debug =====
window.mritDebug = {
  log(on = true) {
    navigator.serviceWorker.controller?.postMessage({ action: "debug:log", value: on });
    console.log("[mritDebug] DEBUG_LOG =", on);
  },
  // FunÃ§Ãµes para gerenciar cÃ³digo salvo
  getCodigoSalvo() {
    const codigo = localStorage.getItem(CODIGO_DISPLAY_KEY);
    console.log("[mritDebug] CÃ³digo salvo:", codigo || "nenhum");
    return codigo;
  },
  limparCodigoSalvo() {
    limparCodigoSalvo();
    console.log("[mritDebug] CÃ³digo salvo removido");
  },
  salvarCodigo(codigo) {
    if (!codigo || !codigo.trim()) {
      console.log("[mritDebug] CÃ³digo invÃ¡lido");
      return;
    }
    localStorage.setItem(CODIGO_DISPLAY_KEY, codigo.trim().toUpperCase());
    console.log("[mritDebug] CÃ³digo salvo:", codigo.trim().toUpperCase());
  },
  verificarCodigoSalvo() {
    verificarCodigoSalvo();
    console.log("[mritDebug] VerificaÃ§Ã£o de cÃ³digo salvo executada");
  },
  getDeviceId() {
    const deviceId = gerarDeviceId();
    console.log("[mritDebug] Device ID:", deviceId);
    return deviceId;
  },
  async getDisplaysPorDevice() {
    const deviceId = gerarDeviceId();
    try {
      // Tentar buscar com campos de dispositivo
      try {
        const { data, error } = await client
          .from("displays")
          .select("codigo_unico, device_id, device_last_seen, status")
          .eq("device_id", deviceId);
        
        if (error) {
          // Se erro for de coluna nÃ£o encontrada, informar
          if (error.message && error.message.includes('column') && error.message.includes('does not exist')) {
            console.log("[mritDebug] Campos de dispositivo ainda nÃ£o criados no banco");
            return null;
          }
          console.error("[mritDebug] Erro:", error);
          return null;
        }
        
        console.log("[mritDebug] Displays vinculados a este dispositivo:", data);
        return data;
      } catch (selectErr) {
        if (selectErr.message && selectErr.message.includes('column') && selectErr.message.includes('does not exist')) {
          console.log("[mritDebug] Campos de dispositivo ainda nÃ£o criados no banco");
          return null;
        }
        throw selectErr;
      }
    } catch (err) {
      console.error("[mritDebug] Erro:", err);
      return null;
    }
  },
  offline(on = true) {
    navigator.serviceWorker.controller?.postMessage({ action: "debug:offline", value: on });
    console.log("[mritDebug] OFFLINE_TEST =", on);
  },
  clearAll() {
    navigator.serviceWorker.controller?.postMessage({ action: "clearAll" });
    console.log("[mritDebug] clearAll enviado ao SW");
  },
  async dump() {
    console.log("Playlist atual:", playlist);
    const req = indexedDB.open("mrit-player-idb", 1);
    req.onsuccess = () => {
      const db = req.result;
      const tx = db.transaction("videos", "readonly");
      const store = tx.objectStore("videos");
      const getKeys = store.getAllKeys();
      getKeys.onsuccess = () => console.log("IDB-videos keys:", getKeys.result);
    };
  },
  async checkCache(url) {
    if (!url) {
      console.log("âŒ URL nÃ£o fornecida");
      return;
    }
    const cacheKey = `${codigoAtual}::${url}`;
    try {
      const blob = await idbGet(cacheKey);
      if (blob) {
        console.log("âœ… VÃ­deo encontrado no cache:", url, "Tamanho:", blob.size, "bytes");
        return true;
      } else {
        console.log("âŒ VÃ­deo NÃƒO encontrado no cache:", url);
        return false;
      }
    } catch (error) {
      console.error("Erro ao verificar cache:", error);
      return false;
    }
  },
  async checkCacheImagem(url) {
    if (!url) {
      console.log("âŒ URL nÃ£o fornecida");
      return;
    }
    try {
      const cache = await caches.open("mrit-player-cache-v13");
      const cachedResponse = await cache.match(url);
      if (cachedResponse && cachedResponse.ok) {
        console.log("âœ… Imagem encontrada no cache:", url);
        return true;
      } else {
        console.log("âŒ Imagem NÃƒO encontrada no cache:", url);
        return false;
      }
    } catch (error) {
      console.error("Erro ao verificar cache da imagem:", error);
      return false;
    }
  },
  async checkAllCache() {
    console.log("ðŸ” Verificando cache para todos os itens da playlist...");
    for (const item of playlist) {
      const url = pickSourceForOrientation(item);
      const isVideo = /\.(mp4|webm|mkv|mov|avi)(\?|$)/i.test(url);
      const isImage = /\.(jpg|jpeg|png|webp)(\?|$)/i.test(url);
      
      if (isVideo) {
        await this.checkCache(url);
      } else if (isImage) {
        await this.checkCacheImagem(url);
      }
    }
  },
  // FunÃ§Ãµes de controle da promoÃ§Ã£o
  atualizarContador(valor) {
    atualizarContadorPromocao(valor);
    console.log(`[mritDebug] Contador atualizado para: ${valor}`);
  },
  fecharPromocao() {
    fecharPopupPromocao();
    console.log("[mritDebug] Popup de promoÃ§Ã£o fechado");
  },
  verificarPromocao() {
    verificarPromocao();
    console.log("[mritDebug] VerificaÃ§Ã£o de promoÃ§Ã£o executada");
  },
  verificarContador() {
    if (promoData && promoData.id_promo) {
      verificarContadorNoBanco(promoData.id_promo);
      console.log("[mritDebug] VerificaÃ§Ã£o de contador executada");
    } else {
      console.log("[mritDebug] Nenhuma promoÃ§Ã£o ativa para verificar contador");
    }
  },
  forcarVerificacao() {
    verificarPromocaoContinuamente();
    console.log("[mritDebug] VerificaÃ§Ã£o forÃ§ada executada");
  },
  async forcarCache() {
    if (navigator.serviceWorker.controller) {
      navigator.serviceWorker.controller.postMessage({
        action: "forceCache",
        playlist: playlist
      });
      console.log("[mritDebug] ForÃ§ando cache da playlist atual via Service Worker");
    } else {
      console.log("[mritDebug] Service Worker nÃ£o disponÃ­vel, usando cache direto");
      await this.forcarCacheDireto();
    }
  },
  async forcarCacheDireto() {
    console.log("ðŸ”„ ForÃ§ando cache direto no IndexedDB...");
    
    if (!playlist || playlist.length === 0) {
      console.log("âŒ Nenhuma playlist carregada");
      return;
    }
    
    let cachedCount = 0;
    let failedCount = 0;
    // Permitir cache de playlists grandes (alinhado ao Service Worker):
    // - Até 50 vídeos (ou todos, se a playlist tiver menos que isso)
    // - Até 5GB por vídeo
    const maxVideos = 50;
    const maxSize = 5 * 1024 * 1024 * 1024; // 5GB
    const maxRetries = 5;
    
    for (const item of playlist) {
      if (cachedCount >= maxVideos) {
        console.log("âš ï¸ Limite de vÃ­deos atingido");
        break;
      }
      
      const url = pickSourceForOrientation(item);
      const isVideo = /\.(mp4|webm|mkv|mov|avi)(\?|$)/i.test(url);
      
      if (!isVideo) {
        console.log("â­ï¸ Pulando item nÃ£o-vÃ­deo:", url);
        continue;
      }
      
      let success = false;
      let retryCount = 0;
      
      while (!success && retryCount <= maxRetries) {
        try {
          // Verificar se jÃ¡ estÃ¡ em cache
          const cacheKey = `${codigoAtual}::${url}`;
          const existingBlob = await idbGet(cacheKey);
          
          if (existingBlob && existingBlob.size > 0) {
            console.log("âœ… JÃ¡ em cache:", url, "Tamanho:", existingBlob.size, "bytes");
            success = true;
            cachedCount++;
            break;
          }
          
          if (retryCount > 0) {
            console.log(`ðŸ”„ Tentativa ${retryCount + 1} de ${maxRetries + 1} para baixar:`, url);
            // Aguardar um pouco antes de tentar novamente
            await new Promise(resolve => setTimeout(resolve, 2000 * retryCount));
          } else {
            console.log("ðŸ“¥ Baixando vÃ­deo:", url);
          }
          
          // Baixar vÃ­deo com timeout maior
          const controller = new AbortController();
          const timeoutId = setTimeout(() => controller.abort(), 60000); // 60 segundos
          
          const response = await fetch(url, { 
            method: 'GET',
            cache: 'no-store',
            signal: controller.signal
          });
          
          clearTimeout(timeoutId);
          
          if (!response.ok) {
            console.log("âŒ Falha ao baixar:", url, "Status:", response.status);
            retryCount++;
            continue;
          }
          
          const blob = await response.blob();
          
          if (!blob || blob.size === 0) {
            console.log("âŒ Blob vazio:", url);
            retryCount++;
            continue;
          }
          
          if (blob.size > maxSize) {
            console.log("âš ï¸ Arquivo muito grande:", url, "Tamanho:", blob.size, "bytes");
            retryCount++;
            continue;
          }
          
          // Salvar no IndexedDB
          await idbSet(cacheKey, blob);
          cachedCount++;
          success = true;
          
          console.log("âœ… VÃ­deo em cache:", url, "Tamanho:", blob.size, "bytes", "MB:", (blob.size / 1024 / 1024).toFixed(2));
          
        } catch (error) {
          retryCount++;
          if (retryCount > maxRetries) {
            console.error("âŒ Erro ao baixar vÃ­deo apÃ³s", maxRetries + 1, "tentativas:", url, error.message);
            failedCount++;
          } else {
            console.warn("âš ï¸ Erro na tentativa", retryCount, "para", url, ":", error.message);
          }
        }
      }
    }
    
    console.log(`ðŸŽ‰ Cache concluÃ­do: ${cachedCount} vÃ­deos armazenados, ${failedCount} falharam`);
    
    // Atualizar status do cache no banco
    if (cachedCount > 0) {
      await atualizarStatusCache(codigoAtual, true);
    }
    
    return { cachedCount, failedCount };
  },
  async forcarCacheImagens() {
    console.log("ðŸ”„ ForÃ§ando cache de imagens...");
    
    if (!playlist || playlist.length === 0) {
      console.log("âŒ Nenhuma playlist carregada");
      return;
    }
    
    let cachedCount = 0;
    let failedCount = 0;
    const maxRetries = 3;
    
    for (const item of playlist) {
      const url = pickSourceForOrientation(item);
      const isImage = /\.(jpg|jpeg|png|webp)(\?|$)/i.test(url);
      
      if (!isImage) {
        continue;
      }
      
      let success = false;
      let retryCount = 0;
      
      while (!success && retryCount <= maxRetries) {
        try {
          // Verificar se jÃ¡ estÃ¡ em cache
          const cache = await caches.open("mrit-player-cache-v13");
          const cachedResponse = await cache.match(url);
          
          if (cachedResponse && cachedResponse.ok) {
            console.log("âœ… Imagem jÃ¡ em cache:", url);
            success = true;
            cachedCount++;
            break;
          }
          
          if (retryCount > 0) {
            console.log(`ðŸ”„ Tentativa ${retryCount + 1} de ${maxRetries + 1} para baixar imagem:`, url);
            await new Promise(resolve => setTimeout(resolve, 1000 * retryCount));
          } else {
            console.log("ðŸ“¥ Baixando imagem:", url);
          }
          
          // Baixar imagem
          const controller = new AbortController();
          const timeoutId = setTimeout(() => controller.abort(), 30000); // 30 segundos
          
          const response = await fetch(url, { 
            method: 'GET',
            cache: 'no-store',
            signal: controller.signal
          });
          
          clearTimeout(timeoutId);
          
          if (!response.ok) {
            console.log("âŒ Falha ao baixar imagem:", url, "Status:", response.status);
            retryCount++;
            continue;
          }
          
          // Salvar no cache
          await cache.put(url, response.clone());
          cachedCount++;
          success = true;
          
          console.log("âœ… Imagem em cache:", url);
          
        } catch (error) {
          retryCount++;
          if (retryCount > maxRetries) {
            console.error("âŒ Erro ao baixar imagem apÃ³s", maxRetries + 1, "tentativas:", url, error.message);
            failedCount++;
          } else {
            console.warn("âš ï¸ Erro na tentativa", retryCount, "para imagem", url, ":", error.message);
          }
        }
      }
    }
    
    console.log(`ðŸŽ‰ Cache de imagens concluÃ­do: ${cachedCount} imagens armazenadas, ${failedCount} falharam`);
    
    return { cachedCount, failedCount };
  },
  async verificarCacheSW(url) {
    return new Promise((resolve) => {
      if (!navigator.serviceWorker.controller) {
        console.log("[mritDebug] Service Worker nÃ£o disponÃ­vel");
        resolve(null);
        return;
      }
      
      const channel = new MessageChannel();
      channel.port1.onmessage = (event) => {
        resolve(event.data);
      };
      
      navigator.serviceWorker.controller.postMessage({
        action: "checkCache",
        url: url
      }, [channel.port2]);
    });
  },
  async verificarTodosCachesSW() {
    console.log("ðŸ” Verificando caches via Service Worker...");
    for (const item of playlist) {
      const url = pickSourceForOrientation(item);
      const result = await this.verificarCacheSW(url);
      if (result) {
        console.log(`${result.cached ? 'âœ…' : 'âŒ'} ${url} - ${result.cached ? result.size + ' bytes' : 'nÃ£o em cache'}`);
      }
    }
  },
  async verificarStatusCacheBanco() {
    if (!codigoAtual) {
      console.log("âŒ Nenhum cÃ³digo de tela ativo");
      return;
    }
    
    try {
      const { data, error } = await client
        .from("displays")
        .select("codigo_unico, cache")
        .eq("codigo_unico", codigoAtual)
        .single();
      
      if (error) {
        console.error("âŒ Erro ao buscar status do cache:", error);
        return;
      }
      
      if (data) {
        console.log(`ðŸ“Š Status do cache no banco: ${data.cache ? 'âœ… Pronto' : 'âŒ NÃ£o pronto'}`);
        return data.cache;
      } else {
        console.log("âŒ Tela nÃ£o encontrada no banco");
        return false;
      }
    } catch (err) {
      console.error("âŒ Erro na conexÃ£o:", err);
      return false;
    }
  },
  async forcarStatusCache(status = true) {
    if (!codigoAtual) {
      console.log("âŒ Nenhum cÃ³digo de tela ativo");
      return;
    }
    
    await atualizarStatusCache(codigoAtual, status);
    console.log(`ðŸ”„ Status do cache forÃ§ado para: ${status ? 'pronto' : 'nÃ£o pronto'}`);
  },
  async verificarCacheCompleto() {
    console.log("ðŸ” VerificaÃ§Ã£o completa do cache...");
    const resultado = await verificarEAtualizarStatusCache();
    console.log(`ðŸ“Š Resultado: ${resultado ? 'âœ… Cache pronto' : 'âŒ Cache nÃ£o pronto'}`);
    return resultado;
  },
  async diagnosticoCompleto() {
    console.log("ðŸ” === DIAGNÃ“STICO COMPLETO DO CACHE ===");
    
    // 1. Verificar Service Worker
    console.log("\n1ï¸âƒ£ Verificando Service Worker...");
    const swAtivo = await this.verificarSW();
    
    // 2. Verificar playlist
    console.log("\n2ï¸âƒ£ Verificando playlist...");
    console.log("ðŸ“Š Playlist carregada:", playlist ? playlist.length : 0, "itens");
    if (playlist && playlist.length > 0) {
      const videos = playlist.filter(item => {
        const url = pickSourceForOrientation(item);
        return /\.(mp4|webm|mkv|mov|avi)(\?|$)/i.test(url);
      });
      const imagens = playlist.filter(item => {
        const url = pickSourceForOrientation(item);
        return /\.(jpg|jpeg|png|webp)(\?|$)/i.test(url);
      });
      console.log("ðŸ“Š VÃ­deos na playlist:", videos.length);
      console.log("ðŸ“Š Imagens na playlist:", imagens.length);
    }
    
    // 3. Verificar cache individual
    console.log("\n3ï¸âƒ£ Verificando cache individual...");
    if (playlist && playlist.length > 0) {
      for (const item of playlist) {
        const url = pickSourceForOrientation(item);
        const isVideo = /\.(mp4|webm|mkv|mov|avi)(\?|$)/i.test(url);
        const isImage = /\.(jpg|jpeg|png|webp)(\?|$)/i.test(url);
        if (isVideo) {
          await this.checkCache(url);
        } else if (isImage) {
          await this.checkCacheImagem(url);
        }
      }
    }
    
    // 4. Verificar status no banco
    console.log("\n4ï¸âƒ£ Verificando status no banco...");
    await this.verificarStatusCacheBanco();
    
    // 5. Verificar cache geral
    console.log("\n5ï¸âƒ£ Verificando cache geral...");
    await this.verificarCacheCompleto();
    
    console.log("\nâœ… DiagnÃ³stico concluÃ­do!");
  },
  async limparCacheEStatus() {
    console.log("ðŸ§¹ Limpando cache e status...");
    
    // Limpar cache local
    if (codigoAtual) {
      const keys = await idbAllKeys();
      const prefix = `${codigoAtual}::`;
      for (const key of keys) {
        if (String(key).startsWith(prefix)) {
          await idbDel(key);
        }
      }
    }
    
    // Marcar como nÃ£o pronto
    await atualizarStatusCache(codigoAtual, false);
    
    console.log("âœ… Cache e status limpos");
  },
  async forcarCacheAutomatico() {
    console.log("ðŸ”„ ForÃ§ando cache automÃ¡tico...");
    
    // Verificar se Service Worker estÃ¡ disponÃ­vel
    if (navigator.serviceWorker.controller) {
      console.log("ðŸ“¤ Usando Service Worker para cache...");
      await this.forcarCache();
    } else {
      console.log("ðŸ“¥ Usando cache direto...");
      await this.forcarCacheDireto();
    }
    
    // Aguardar um pouco e verificar
    setTimeout(async () => {
      await this.verificarCacheCompleto();
    }, 2000);
  },
  async forcarCacheCompleto() {
    console.log("ðŸ”„ ForÃ§ando cache completo (vÃ­deos + imagens)...");
    
    const resultadoVideos = await this.forcarCacheDireto();
    const resultadoImagens = await this.forcarCacheImagens();
    
    console.log(`ðŸŽ‰ Cache completo concluÃ­do:`);
    console.log(`ðŸ“¹ VÃ­deos: ${resultadoVideos.cachedCount} cacheados, ${resultadoVideos.failedCount} falharam`);
    console.log(`ðŸ–¼ï¸ Imagens: ${resultadoImagens.cachedCount} cacheadas, ${resultadoImagens.failedCount} falharam`);
    
    // Verificar status final
    await this.verificarCacheCompleto();
    
    return { videos: resultadoVideos, imagens: resultadoImagens };
  },
  async verificarSW() {
    console.log("ðŸ” Verificando Service Worker...");
    
    if (!('serviceWorker' in navigator)) {
      console.log("âŒ Service Worker nÃ£o suportado neste navegador");
      return false;
    }
    
    try {
      const registration = await navigator.serviceWorker.getRegistration();
      if (!registration) {
        console.log("âŒ Service Worker nÃ£o registrado");
        return false;
      }
      
      console.log("âœ… Service Worker registrado:", registration.scope);
      
      if (!navigator.serviceWorker.controller) {
        console.log("âš ï¸ Service Worker registrado mas nÃ£o estÃ¡ controlando a pÃ¡gina");
        console.log("ðŸ’¡ Tente recarregar a pÃ¡gina ou aguardar alguns segundos");
        return false;
      }
      
      console.log("âœ… Service Worker ativo e controlando a pÃ¡gina");
      return true;
    } catch (error) {
      console.error("âŒ Erro ao verificar Service Worker:", error);
      return false;
    }
  },
  async registrarSW() {
    console.log("ðŸ”„ Tentando registrar Service Worker...");
    
    if (!('serviceWorker' in navigator)) {
      console.log("âŒ Service Worker nÃ£o suportado neste navegador");
      return false;
    }
    
    try {
      const registration = await navigator.serviceWorker.register('service-worker.js');
      console.log("âœ… Service Worker registrado com sucesso:", registration.scope);
      
      // Aguardar o SW estar pronto
      await navigator.serviceWorker.ready;
      console.log("âœ… Service Worker pronto para uso");
      
      return true;
    } catch (error) {
      console.error("âŒ Erro ao registrar Service Worker:", error);
      return false;
    }
  },
  async reiniciarSW() {
    console.log("ðŸ”„ Reiniciando Service Worker...");
    
    try {
      // Desregistrar SW atual
      const registrations = await navigator.serviceWorker.getRegistrations();
      for (const registration of registrations) {
        await registration.unregister();
        console.log("ðŸ—‘ï¸ Service Worker desregistrado:", registration.scope);
      }
      
      // Aguardar um pouco
      await new Promise(resolve => setTimeout(resolve, 1000));
      
      // Registrar novamente
      const success = await this.registrarSW();
      if (success) {
        console.log("âœ… Service Worker reiniciado com sucesso");
        // Recarregar a pÃ¡gina para ativar o novo SW
        console.log("ðŸ”„ Recarregando pÃ¡gina em 2 segundos...");
        setTimeout(() => location.reload(), 2000);
      }
      
      return success;
    } catch (error) {
      console.error("âŒ Erro ao reiniciar Service Worker:", error);
      return false;
    }
  }
};




// ===== Cache Integrity Check =====
// Roda 45s após o cache ser atualizado pelo SW.
// Para cada vídeo em cache, tenta decodificar o blob com um elemento <video>.
// Se a duração retornar null, o blob está corrompido/incompleto — remove e pede recache.
const CACHE_INTEGRITY_CHECK_DELAY_MS = 45000;
const CACHE_INTEGRITY_MIN_DURATION_S = 0.5;

// ===== Force Recache individual de item da playlist =====
async function processarForceRecache(itens) {
  const toRecache = (itens || []).filter(i => i.force_recache);
  if (!toRecache.length) return;

  // Avisa o painel que o cache está sendo refeito
  await atualizarStatusCache(codigoAtual, false, false);

  for (const item of toRecache) {
    const urls = [item.url, item.urlPortrait, item.urlLandscape].filter(Boolean);
    for (const url of urls) {
      try { await deleteCachedVideoEntries(url); } catch {}
      try {
        const cache = await caches.open('mrit-player-cache-v13');
        await cache.delete(url);
      } catch {}
    }
  }

  // Solicitar re-download ao SW
  if (navigator.serviceWorker?.controller) {
    navigator.serviceWorker.controller.postMessage({ action: 'updateCache', playlist: toRecache });
  }

  // Zerar force_recache no banco
  try {
    const ids = toRecache.map(i => i.id).filter(Boolean);
    if (ids.length) await client.from('playlist_itens').update({ force_recache: false }).in('id', ids);
  } catch {}

  // Agenda verificação para atualizar cache_ready quando re-download concluir
  agendarVerificacaoIntegridade();
}

let cacheIntegrityTimer = null;

function agendarVerificacaoIntegridade() {
  if (cacheIntegrityTimer) clearTimeout(cacheIntegrityTimer);
  cacheIntegrityTimer = setTimeout(verificarIntegridadeCache, CACHE_INTEGRITY_CHECK_DELAY_MS);
}

async function verificarIntegridadeCache() {
  if (!codigoAtual || !playlist || playlist.length === 0) return;

  const urlsParaRefazer = [];

  for (const item of playlist) {
    const url = pickSourceForOrientation(item);
    if (!/\.(mp4|webm|mkv|mov|avi|m4v|3gp)(\?|$)/i.test(url)) continue;

    let blob;
    try { blob = await idbGet(`${codigoAtual}::${url}`); } catch { continue; }
    if (!blob || blob.size === 0) continue; // não cacheado ainda, SW cuida disso

    const duration = await readVideoDurationFromBlob(blob);
    if (duration === null || duration < CACHE_INTEGRITY_MIN_DURATION_S) {
      console.warn('[cache-integrity] Blob inválido detectado — removendo para recache:', url,
        '| tamanho:', blob.size, 'bytes | duração decodificada:', duration);
      await deleteCachedVideoEntries(url);
      urlsParaRefazer.push(url);
    }

    // Pausa entre verificações para não bloquear a thread de UI
    await new Promise(r => setTimeout(r, 300));
  }

  if (urlsParaRefazer.length === 0) {
    console.log('[cache-integrity] Todos os vídeos em cache verificados e válidos.');
    verificarEAtualizarStatusCache();
    return;
  }

  console.warn('[cache-integrity]', urlsParaRefazer.length, 'vídeo(s) corrompido(s) removido(s) — solicitando recache ao SW');
  const itens = playlist.filter(item => urlsParaRefazer.includes(pickSourceForOrientation(item)));
  navigator.serviceWorker?.controller?.postMessage({ action: 'updateCache', playlist: itens });
}

// ===== Remote Screenshot =====
// O painel seta screenshot_pending = true na tabela displays.
// O player detecta a flag a cada 6s, captura o frame atual via canvas, envia ao Supabase Storage
// e grava screenshot_url + screenshot_at de volta na tabela.
const SCREENSHOT_POLL_MS = 6000;
let screenshotPollTimer = null;

function iniciarPollScreenshot() {
  pararPollScreenshot();
  screenshotPollTimer = setInterval(verificarScreenshotPendente, SCREENSHOT_POLL_MS);
}

function pararPollScreenshot() {
  if (screenshotPollTimer) { clearInterval(screenshotPollTimer); screenshotPollTimer = null; }
}

async function verificarScreenshotPendente() {
  if (!codigoAtual || !navigator.onLine) return;
  try {
    const { data, error } = await client
      .from('displays')
      .select('screenshot_pending')
      .eq('codigo_unico', codigoAtual)
      .maybeSingle();
    if (!error && data?.screenshot_pending) await processarSolicitacaoScreenshot();
  } catch {}
}

async function capturarScreenshot() {
  const width = window.innerWidth || 1920;
  const height = window.innerHeight || 1080;

  function blobFromCanvas(cnv) {
    return new Promise(function(res, rej) {
      cnv.toBlob(function(b) { b ? res(b) : rej(new Error('toBlob retornou null')); }, 'image/jpeg', 0.75);
    });
  }

  function canvasFallback() {
    var fb = document.createElement('canvas');
    fb.width = width; fb.height = height;
    var c2 = fb.getContext('2d');
    c2.fillStyle = '#0d1117'; c2.fillRect(0, 0, width, height);
    c2.fillStyle = '#58a6ff'; c2.font = 'bold 52px sans-serif';
    c2.textAlign = 'center'; c2.textBaseline = 'middle';
    c2.fillText(codigoAtual || 'MRIT Vision', width / 2, height / 2 - 28);
    c2.fillStyle = '#8b949e'; c2.font = '26px sans-serif';
    c2.fillText(new Date().toLocaleString('pt-BR'), width / 2, height / 2 + 36);
    return fb;
  }

  // Tenta capturar a mídia ativa num canvas separado
  try {
    var canvas = document.createElement('canvas');
    canvas.width = width; canvas.height = height;
    var ctx = canvas.getContext('2d');
    ctx.fillStyle = '#000'; ctx.fillRect(0, 0, width, height);

    if (activeMediaType === 'video') {
      var activeVid = getUniqueVideoEls().find(function(v) { return v.style.display !== 'none' && v.readyState >= 2; });
      if (activeVid) ctx.drawImage(activeVid, 0, 0, width, height);
    } else if (activeMediaType === 'image' && img && img.complete && img.naturalWidth > 0) {
      ctx.drawImage(img, 0, 0, width, height);
    }

    // toBlob pode lançar SecurityError se o canvas foi contaminado por CORS
    return await blobFromCanvas(canvas);
  } catch (e) {
    console.warn('[screenshot] Canvas contaminado ou erro na captura, usando fallback:', e.message);
  }

  // Fallback garantido: canvas limpo com código e horário
  try {
    return await blobFromCanvas(canvasFallback());
  } catch (e) {
    console.error('[screenshot] Fallback também falhou:', e.message);
    return null;
  }
}

async function processarSolicitacaoScreenshot() {
  var etapa = 'reset';
  try {
    await client.from('displays')
      .update({ screenshot_pending: false })
      .eq('codigo_unico', codigoAtual);

    etapa = 'captura';
    var blob = await capturarScreenshot();
    if (!blob) {
      await client.from('displays').update({
        screenshot_url: 'ERRO: blob nulo (canvas falhou)',
        screenshot_at: new Date().toISOString()
      }).eq('codigo_unico', codigoAtual);
      return;
    }

    etapa = 'upload';
    var filename = codigoAtual + '/latest.jpg';
    var uploadResult = await client.storage
      .from('screenshots')
      .upload(filename, blob, { contentType: 'image/jpeg', upsert: true });

    if (uploadResult.error) {
      await client.from('displays').update({
        screenshot_url: 'ERRO upload: ' + uploadResult.error.message,
        screenshot_at: new Date().toISOString()
      }).eq('codigo_unico', codigoAtual);
      console.warn('[screenshot] Erro upload:', uploadResult.error.message);
      return;
    }

    etapa = 'url';
    var urlResult = client.storage.from('screenshots').getPublicUrl(filename);
    var publicUrl = urlResult.data && urlResult.data.publicUrl
      ? urlResult.data.publicUrl + '?t=' + Date.now()
      : null;

    await client.from('displays').update({
      screenshot_url: publicUrl,
      screenshot_at: new Date().toISOString()
    }).eq('codigo_unico', codigoAtual);

    console.log('[screenshot] OK:', publicUrl);
  } catch (err) {
    console.error('[screenshot] Erro em etapa', etapa, ':', err && err.message);
    try {
      await client.from('displays').update({
        screenshot_url: 'ERRO ' + etapa + ': ' + (err && err.message ? err.message : String(err)),
        screenshot_at: new Date().toISOString()
      }).eq('codigo_unico', codigoAtual);
    } catch (_) {}
  }
}
// ===== Feed Item (tipo: "feed") — overlay inline, sem iframe =====

function feedFechar() {
  clearTimeout(feedTimer);    feedTimer    = null;
  clearTimeout(feedSlideTimer); feedSlideTimer = null;
  clearInterval(feedClockInt);  feedClockInt   = null;
  var el = document.getElementById('feedPlayer');
  if (el) el.style.display = 'none';
}

function _feedFormatDate(str) {
  if (!str) return '';
  try { return new Date(str).toLocaleDateString('pt-BR', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }); } catch(e) { return ''; }
}

function _feedFatiarComOffset(articles, maxSlides, query) {
  if (!articles.length) return [];
  var offset  = feedOffsets[query] || 0;
  var total   = articles.length;
  offset      = offset % total;
  var slice   = articles.slice(offset, offset + maxSlides);
  if (slice.length < maxSlides) {
    slice = slice.concat(articles.slice(0, maxSlides - slice.length));
  }
  feedOffsets[query] = (offset + maxSlides) % total;
  return slice;
}

function _feedSalvarCache(query, articles) {
  try { localStorage.setItem('mrit_feed_' + query.replace(/\s+/g,'_'), JSON.stringify({ ts: Date.now(), articles: articles })); } catch(e) {}
}

function _feedCarregarCache(query) {
  try {
    var raw = localStorage.getItem('mrit_feed_' + query.replace(/\s+/g,'_'));
    if (!raw) return null;
    var p = JSON.parse(raw);
    return (Array.isArray(p.articles) && p.articles.length) ? p.articles : null;
  } catch(e) { return null; }
}

function _feedConstruirSlides(articles, maxSlides, query) {
  var carousel = document.getElementById('feed-carousel');
  var dotsEl   = document.getElementById('feed-dots');
  if (!carousel || !dotsEl) return;
  var limited = articles.slice(0, maxSlides);
  carousel.innerHTML = '';
  dotsEl.innerHTML   = '';
  feedCurrent = 0; feedSlidesShown = 0; feedItems = limited;
  limited.forEach(function(it, i) {
    var hasImg = !!(it.image_url && it.image_url.startsWith('http'));
    var slide  = document.createElement('div');
    slide.className = 'feed-slide' + (hasImg ? '' : ' feed-no-image') + (i === 0 ? ' active' : '');
    slide.innerHTML =
      '<div class="feed-slide-bg"' + (hasImg ? ' style="background-image:url(\'' + it.image_url + '\')"' : '') + '></div>' +
      '<div class="feed-slide-content">' +
        '<div class="feed-slide-tag">' + (query.charAt(0).toUpperCase() + query.slice(1)) + '</div>' +
        '<div class="feed-slide-title">' + (it.title || '').replace(/\s*-\s*[^-]+$/, '') + '</div>' +
        (it.description ? '<div class="feed-slide-desc">' + it.description + '</div>' : '') +
        '<div class="feed-slide-meta">' +
          '<span class="feed-slide-source">' + (it.source_name || 'Notícia') + '</span>' +
          '<span class="feed-slide-date">'   + _feedFormatDate(it.pubDate)   + '</span>' +
        '</div>' +
      '</div>';
    carousel.appendChild(slide);
    var dot = document.createElement('div');
    dot.className = 'feed-dot' + (i === 0 ? ' active' : '');
    dotsEl.appendChild(dot);
  });
}

function _feedGoTo(index) {
  var slides = document.querySelectorAll('.feed-slide');
  var dots   = document.querySelectorAll('.feed-dot');
  if (!slides.length) return;
  slides[feedCurrent].classList.remove('active');
  if (dots[feedCurrent]) dots[feedCurrent].classList.remove('active');
  feedCurrent = (index + feedItems.length) % feedItems.length;
  slides[feedCurrent].classList.add('active');
  if (dots[feedCurrent]) dots[feedCurrent].classList.add('active');
}

function _feedStartProgress(slideDuration, maxSlides, token) {
  var bar = document.getElementById('feed-progress');
  if (bar) {
    bar.style.transition = 'none'; bar.style.width = '0%';
    requestAnimationFrame(function() { requestAnimationFrame(function() {
      bar.style.transition = 'width ' + (slideDuration * 1000) + 'ms linear';
      bar.style.width = '100%';
    }); });
  }
  clearTimeout(feedSlideTimer);
  feedSlideTimer = setTimeout(function() {
    if (playToken !== token) return;
    feedSlidesShown++;
    if (feedSlidesShown >= maxSlides || feedSlidesShown >= feedItems.length) {
      clearTimeout(feedTimer); feedTimer = null;
      feedFechar();
      isPlaying = false;
      proximoItem();
    } else {
      _feedGoTo(feedCurrent + 1);
      _feedStartProgress(slideDuration, maxSlides, token);
    }
  }, slideDuration * 1000);
}

async function tocarFeedItem(item, token) {
  var feedEl = document.getElementById('feedPlayer');
  if (!feedEl) { proximoItem(); return; }

  var query         = item.feed_query         || 'futebol';
  var slides        = Math.max(1, parseInt(item.feed_slides)         || 3);
  var slideDuration = Math.max(3, parseInt(item.feed_slide_duration) || 7);
  var edgeUrl       = supabaseUrl + '/functions/v1/news-feed';

  feedEl.style.display = 'block';
  isPlaying = true;

  // Relógio no header
  clearInterval(feedClockInt);
  function _feedTick() { var c = document.getElementById('feed-header-clock'); if (c) c.textContent = new Date().toLocaleTimeString('pt-BR', { hour:'2-digit', minute:'2-digit' }); }
  _feedTick(); feedClockInt = setInterval(_feedTick, 1000);
  var ht = document.getElementById('feed-header-title');
  if (ht) ht.textContent = query.charAt(0).toUpperCase() + query.slice(1);

  // Timer de segurança
  clearTimeout(feedTimer);
  feedTimer = setTimeout(function() {
    if (playToken !== token) return;
    feedFechar(); isPlaying = false; proximoItem();
  }, slides * slideDuration * 1000 + 3000);

  // Reusar artigos em memória do mesmo query
  if (feedCurrentQuery === query && feedArticlesFull.length > 0) {
    var ov0 = document.getElementById('feed-overlay');
    if (ov0) ov0.style.display = 'none';
    _feedConstruirSlides(_feedFatiarComOffset(feedArticlesFull, slides, query), slides, query);
    _feedStartProgress(slideDuration, slides, token);
    return;
  }

  feedCurrentQuery = query; feedItems = [];
  var ov = document.getElementById('feed-overlay');
  if (ov) ov.innerHTML = '<div class="feed-spinner"></div><span id="feed-overlay-text">Carregando…</span>';
  if (ov) ov.style.display = 'flex';

  var articles = null;
  try {
    var res  = await fetch(edgeUrl + '?query=' + encodeURIComponent(query) + '&language=pt&category=sports');
    var data = await res.json();
    if (data.status === 'success' && data.results && data.results.length) {
      articles = data.results.filter(function(a) { return a.title; });
      _feedSalvarCache(query, articles);
    }
  } catch(e) {}

  if (!articles || !articles.length) articles = _feedCarregarCache(query);
  if (playToken !== token) return;

  if (articles && articles.length) {
    feedArticlesFull = articles;
    feedOffsets[query] = 0; // reset ao buscar artigos novos
    _feedConstruirSlides(_feedFatiarComOffset(articles, slides, query), slides, query);
    if (ov) ov.style.display = 'none';
    _feedStartProgress(slideDuration, slides, token);
  } else {
    if (ov) ov.innerHTML = '<span style="color:#e55;font-size:clamp(0.8rem,2vmin,1rem)">Sem notícias disponíveis</span>';
  }
}