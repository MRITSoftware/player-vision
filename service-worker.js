// service-worker.js
// -------------------------------------------------------
// MRIT Player SW — v12 (namespaced + smooth video cache)
// - Namespace por tela (CURRENT_NS) para isolar cache
// - Serve MP4/WebM do IDB com Range quando disponível
// - Bypass Storage/Range só quando NÃO temos o vídeo no IDB
// - Precache sequencial e limitado (evita travas)
// - Limpeza por namespace quando a tela sai de uso
// -------------------------------------------------------

const CACHE_NAME = "mrit-player-cache-v13"; // bump para forçar update (limites aumentados)
const DB_NAME = "mrit-player-idb";
const DB_STORE = "videos"; // guarda blobs por namespace

// ===== HLS settings =====
const HLS_CACHE = CACHE_NAME;
const HLS_PREFETCH = 24;           // ~48s (aumentado para melhor buffering)
const HLS_FETCH_TIMEOUT_MS = 3500; // timeout curto

// ===== Debug & Estado =====
let DEBUG_LOG = false;
let OFFLINE_TEST = false;
let CURRENT_NS = "global"; // namespace da tela (ex.: CÓDIGO)

// Limites de cache (simples e efetivos)
const MAX_VIDEOS_PER_NS = 50;       // até 50 vídeos por tela (aumentado para dispositivos com mais memória)
const MAX_VIDEO_BYTES = 5 * 1024 * 1024 * 1024; // 5GB por vídeo (aumentado para suportar vídeos maiores)

function dlog(...args) { if (DEBUG_LOG) console.log("[SW]", ...args); }
const nsKey = (url) => `${CURRENT_NS}::${url}`;

// ===== IndexedDB Helpers =====
function idbOpen() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(DB_STORE)) {
        db.createObjectStore(DB_STORE); // key: `${ns}::${url}`, value: Blob
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbGet(key) {
  const db = await idbOpen();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(DB_STORE, "readonly");
    const store = tx.objectStore(DB_STORE);
    const req = store.get(key);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}

async function idbSet(key, valueBlob) {
  const db = await idbOpen();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(DB_STORE, "readwrite");
    const store = tx.objectStore(DB_STORE);
    const req = store.put(valueBlob, key);
    req.onsuccess = () => resolve(true);
    req.onerror = () => reject(req.error);
  });
}

async function idbDel(key) {
  const db = await idbOpen();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(DB_STORE, "readwrite");
    const store = tx.objectStore(DB_STORE);
    const req = store.delete(key);
    req.onsuccess = () => resolve(true);
    req.onerror = () => reject(req.error);
  });
}

async function idbAllKeys() {
  const db = await idbOpen();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(DB_STORE, "readonly");
    const store = tx.objectStore(DB_STORE);
    const req = store.getAllKeys();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}

async function idbClearNamespace(ns) {
  const prefix = `${ns}::`;
  const keys = await idbAllKeys();
  await Promise.all(keys.map(k => (String(k).startsWith(prefix) ? idbDel(k) : null)));
}

// ===== SW Lifecycle =====
self.addEventListener("install", (event) => {
  dlog("install");
  self.skipWaiting();
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll([])));
});

self.addEventListener("activate", (event) => {
  dlog("activate");
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.map((n) => (n !== CACHE_NAME ? caches.delete(n) : null)));
    await self.clients.claim();
  })());
});

// ===== Timeout helper =====
function fetchWithTimeout(request, ms = 3000, opts = {}) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), ms);
  const finalOpts = { ...opts, signal: controller.signal };
  return fetch(request, finalOpts).finally(() => clearTimeout(id));
}

// ===== Network helper (respeita OFFLINE_TEST) =====
async function netFetch(request, opts, timeoutMs) {
  if (OFFLINE_TEST) throw new Error("offline-test");
  const finalOpts = { cache: "no-store", ...opts };
  if (timeoutMs && timeoutMs > 0) return fetchWithTimeout(request, timeoutMs, finalOpts);
  return fetch(request, finalOpts);
}

// ===== URL helpers =====
function isSupabaseStorageURL(urlObj) {
  const host = urlObj.hostname;
  const path = urlObj.pathname;
  return host.includes("base.muraltv.com.br") && path.startsWith("/storage/v1/object/");
}

// ===== Fetch Handler =====
self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;

  const req = event.request;
  const url = new URL(req.url);
  const pathname = url.pathname.toLowerCase();

  const isHlsManifest = /\.m3u8(\?|$)/i.test(pathname);
  const isHlsSegment = /\.(m4s|ts)(\?|$)/i.test(pathname);
  const isVideo = /\.(mp4|webm|mkv|mov|avi)(\?|$)/i.test(pathname);
  const isImage = /\.(jpg|jpeg|png|webp)(\?|$)/i.test(pathname);
  const hasRange = req.headers.has("range");
  const storageUrl = isSupabaseStorageURL(url);

  // HLS permanece do jeito que já funcionava
  if (isHlsManifest) {
    event.respondWith(handleHlsManifest(req));
    return;
  }
  if (isHlsSegment) {
    event.respondWith(handleHlsSegment(req));
    return;
  }

  // Imagens → cache-first
  if (isImage) {
    event.respondWith(cacheFirst(req));
    return;
  }

  // Vídeos (MP4/WebM...)
  if (isVideo) {
    event.respondWith((async () => {
      const key = nsKey(req.url);
      const blob = await idbGet(key);

      // 1) Se já temos no IDB, servimos do cache com suporte a Range (suave)
      if (blob) {
        return serveBlobWithRange(req, blob);
      }

      // 2) Se NÃO temos cache:
      //    - Requests com Range → rede direta (servidor responde 206)
      //    - URLs do Supabase Storage → rede direta (evita CORS/Range issues)
      if (hasRange || storageUrl) {
        return fetch(req, { cache: "no-store" });
      }

      // 3) Caso contrário (vídeo externo sem cache), rede com timeout
      try {
        const resp = await netFetch(req, undefined, 3500);
        return resp;
      } catch {
        return new Response("Offline", { status: 503 });
      }
    })());
    return;
  }

  // APIs do Supabase → sempre bypass
  const isSupabaseApi =
    url.hostname.includes("supabase") ||
    (url.hostname.includes("base.muraltv.com.br") && (
      pathname.startsWith("/rest/") ||
      pathname.startsWith("/realtime/") ||
      pathname.startsWith("/auth/")
    ));
  if (isSupabaseApi) {
    event.respondWith(fetch(req, { cache: "no-store" }));
    return;
  }

  // Outros assets → network-first
  event.respondWith(networkFirst(req));
});

// ===== Genéricos (imagem/others) =====
async function cacheFirst(request) {
  const cached = await caches.match(request);
  if (cached) return cached;
  try {
    const resp = await netFetch(request, { cache: "no-store" }, 4000);
    if (resp && resp.ok) {
      const cache = await caches.open(CACHE_NAME);
      await cache.put(request, resp.clone());
    }
    return resp;
  } catch {
    return new Response("Offline", { status: 503 });
  }
}

async function networkFirst(request) {
  try {
    const resp = await netFetch(request, { cache: "no-store" }, 4000);
    if (resp && resp.ok) {
      const cache = await caches.open(CACHE_NAME);
      await cache.put(request, resp.clone());
    }
    return resp;
  } catch {
    const cached = await caches.match(request);
    return cached || new Response("Offline", { status: 503 });
  }
}

// ===== Serve Blob (com suporte a Range) =====
function serveBlobWithRange(request, blob) {
  const range = request.headers.get("Range");
  const size = blob.size;

  if (range) {
    const match = /bytes=(\d*)-(\d*)/.exec(range);
    let start = 0, end = size - 1;
    if (match) {
      if (match[1]) start = parseInt(match[1], 10);
      if (match[2]) end = parseInt(match[2], 10);
    }
    start = isNaN(start) ? 0 : start;
    end = isNaN(end) ? size - 1 : Math.min(end, size - 1);

    if (start > end || start >= size) {
      return new Response(null, {
        status: 416,
        headers: { "Content-Range": `bytes */${size}` },
      });
    }

    const sliced = blob.slice(start, end + 1);
    return new Response(sliced, {
      status: 206,
      headers: {
        "Content-Type": guessContentType(new URL(request.url).pathname),
        "Accept-Ranges": "bytes",
        "Content-Range": `bytes ${start}-${end}/${size}`,
        "Content-Length": String(end - start + 1),
      },
    });
  }

  return new Response(blob, {
    status: 200,
    headers: {
      "Content-Type": guessContentType(new URL(request.url).pathname),
      "Accept-Ranges": "bytes",
      "Content-Length": String(size),
    },
  });
}

// ===== HLS: manifest + segmentos com prefetch =====
async function handleHlsManifest(request) {
  const cache = await caches.open(HLS_CACHE);
  const cached = await cache.match(request);
  let netResp;
  try {
    netResp = await netFetch(request, { cache: "no-store" }, HLS_FETCH_TIMEOUT_MS);
  } catch {}

  if (netResp && netResp.ok) {
    cache.put(request, netResp.clone());
    prefetchFromManifest(request.url, await netResp.clone().text()).catch(() => {});
    return netResp;
  }
  if (cached) {
    cached.clone().text().then(txt => prefetchFromManifest(request.url, txt)).catch(() => {});
    return cached;
  }
  return new Response("Offline", { status: 503 });
}

async function handleHlsSegment(request) {
  const cache = await caches.open(HLS_CACHE);
  const cached = await cache.match(request);
  if (cached) return cached;

  try {
    const resp = await netFetch(request, { cache: "no-store" }, HLS_FETCH_TIMEOUT_MS);
    if (resp && resp.ok) {
      cache.put(request, resp.clone());
      bestEffortPrefetchNextSegments(request.url, cache).catch(() => {});
    }
    return resp;
  } catch {
    return new Response("Offline", { status: 503 });
  }
}

function resolveRelative(baseUrl, rel) {
  try { return new URL(rel, baseUrl).href; } catch { return null; }
}

async function prefetchFromManifest(manifestUrl, manifestText) {
  const cache = await caches.open(HLS_CACHE);
  const lines = manifestText.split(/\r?\n/);
  const segs = [];
  for (const ln of lines) {
    const t = ln.trim();
    if (!t || t.startsWith("#")) continue;
    const abs = resolveRelative(manifestUrl, t);
    if (abs) segs.push(abs);
    if (segs.length >= HLS_PREFETCH) break;
  }
  for (const u of segs) {
    try {
      const hit = await cache.match(u);
      if (!hit) {
        const r = await netFetch(u, { cache: "no-store" }, HLS_FETCH_TIMEOUT_MS);
        if (r && r.ok) await cache.put(u, r.clone());
      }
    } catch {}
  }
}

async function bestEffortPrefetchNextSegments(segUrl, cache) {
  const m = segUrl.match(/(\d+)(\.(m4s|ts))(?:$|\?)/);
  if (!m) return;
  const base = segUrl.replace(/(\d+)(\.(m4s|ts))(?:$|\?).*$/, "");
  const index = parseInt(m[1], 10);
  const ext = m[2];
  for (let i = 1; i <= HLS_PREFETCH; i++) {
    const nextUrl = `${base}${index + i}${ext}`;
    try {
      const hit = await cache.match(nextUrl);
      if (!hit) {
        const r = await netFetch(nextUrl, { cache: "no-store" }, HLS_FETCH_TIMEOUT_MS);
        if (r && r.ok) await cache.put(nextUrl, r.clone());
      }
    } catch {}
  }
}

// ===== Mensagens & Background Cache =====
self.addEventListener("message", async (event) => {
  const { action, playlist, url, value, namespace } = event.data || {};

  if (action === "setNamespace" && namespace) {
    CURRENT_NS = String(namespace);
    dlog("CURRENT_NS =", CURRENT_NS);
    return;
  }

  if (action === "updateCache") {
    dlog("📥 Recebida playlist para cache:", playlist?.length, "itens");
    await updateCacheForCurrentNS(playlist);
    dlog("✅ Cache atualizado para namespace:", CURRENT_NS);
    
    // Notificar o cliente que o cache foi atualizado
    self.clients.matchAll().then(clients => {
      clients.forEach(client => {
        client.postMessage({ action: "cacheUpdated", namespace: CURRENT_NS });
      });
      dlog("📤 Notificação enviada para", clients.length, "clientes");
    });
    return;
  }

  if (action === "clearNamespace") {
    await idbClearNamespace(CURRENT_NS);
    const cache = await caches.open(CACHE_NAME);
    const keys = await cache.keys();
    // Limpa imagens/HLS ligados ao domínio do Storage (opcional)
    for (const req of keys) {
      const u = new URL(req.url);
      if (isSupabaseStorageURL(u)) await cache.delete(req);
    }
    return;
  }

  if (action === "clearAll") {
    await caches.delete(CACHE_NAME);
    await idbClearNamespace(CURRENT_NS);
    return;
  }

  if (action === "debug:log") {
    DEBUG_LOG = !!value;
    dlog("DEBUG_LOG =", DEBUG_LOG);
    return;
  }

  if (action === "debug:offline") {
    OFFLINE_TEST = !!value;
    dlog("OFFLINE_TEST =", OFFLINE_TEST);
    return;
  }

  if (action === "forceCache") {
    dlog("forçando cache para playlist:", playlist);
    await updateCacheForCurrentNS(playlist);
    return;
  }

  if (action === "checkCache") {
    const url = event.data.url;
    if (!url) return;
    
    const key = nsKey(url);
    const blob = await idbGet(key);
    const result = {
      url: url,
      cached: !!blob,
      size: blob ? blob.size : 0,
      key: key
    };
    
    // Enviar resposta de volta para o cliente
    if (event.ports && event.ports[0]) {
      event.ports[0].postMessage(result);
    }
    return;
  }
});

// Atualiza cache para o namespace atual (imagens → Cache API; vídeos → IDB)
async function updateCacheForCurrentNS(playlist) {
  if (!playlist?.length) return;

  // 1) Limpa vídeos do IDB que não pertencem a este playlist (dentro do NS)
  const keys = await idbAllKeys();
  const keepUrls = new Set(playlist.map(i => i.url));
  const prefix = `${CURRENT_NS}::`;
  await Promise.all(keys.map(k => {
    const ks = String(k);
    if (!ks.startsWith(prefix)) return null;
    const url = ks.slice(prefix.length);
    return keepUrls.has(url) ? null : idbDel(ks);
  }));

  // 1.5) Limpa imagens do Cache API que não pertencem a este playlist
  const cache = await caches.open(CACHE_NAME);
  const cacheKeys = await cache.keys();
  await Promise.all(cacheKeys.map(async (req) => {
    const url = req.url;
    const isImage = /\.(jpg|jpeg|png|webp)(\?|$)/i.test(url);
    if (isImage && !keepUrls.has(url)) {
      await cache.delete(req);
      dlog("imagem removida do cache (não está na nova playlist):", url);
    }
  }));

  // 2) Precache sequencial, limitado
  let cachedCount = 0;

  for (const item of playlist) {
    const url = item.url;
    const u = new URL(url);
    const isStorage = isSupabaseStorageURL(u);

    try {
      if (/\.m3u8(\?|$)/i.test(url)) {
        const r = await netFetch(url, { cache: "no-store" }, 5000);
        if (r && r.ok) {
          const cache = await caches.open(CACHE_NAME);
          await cache.put(url, r.clone());
          prefetchFromManifest(url, await r.clone().text()).catch(()=>{});
        }
        continue;
      }

      if (/\.(jpg|jpeg|png|webp)(\?|$)/i.test(url)) {
        // Verificar se já existe no cache antes de baixar
        const cached = await cache.match(url);
        if (cached) {
          dlog("imagem já em cache, pulando:", url);
          continue;
        }
        
        const resp = await netFetch(url, { cache: "no-store" }, 5000);
        if (resp.ok) {
          await cache.put(url, resp.clone());
        }
        continue;
      }

      if (/\.(mp4|webm|mkv|mov|avi)(\?|$)/i.test(url)) {
        if (cachedCount >= MAX_VIDEOS_PER_NS) {
          dlog("limite de vídeos em cache atingido para NS", CURRENT_NS);
          continue;
        }
        
        // Verificar se já existe no cache
        const existingBlob = await idbGet(nsKey(url));
        if (existingBlob) {
          dlog("vídeo já em cache, pulando:", url);
          continue;
        }
        
        // Baixar vídeo inteiro: só faz sentido se o servidor permite CORS
        // e o arquivo não for gigantesco.
        // IMPORTANTE: Não bloquear reprodução - fazer em background com timeout maior
        dlog("baixando vídeo para cache (background):", url);
        
        // Usar timeout muito maior para internet lenta (120s = 2 minutos)
        // Isso evita que trave quando a internet está lenta
        try {
          const headResp = await netFetch(url, { method: "GET", cache: "no-store" }, 120000);
          if (!headResp.ok) {
            dlog("falha ao baixar vídeo:", url, "status:", headResp.status);
            continue;
          }
          
          const blob = await headResp.blob();
          if (!blob || blob.size === 0) {
            dlog("blob vazio ou inválido:", url);
            continue;
          }
          
          if (blob.size > MAX_VIDEO_BYTES) {
            dlog("pulado (arquivo grande)", url, blob.size, "limite:", MAX_VIDEO_BYTES);
            continue;
          }
          
          dlog("vídeo em cache:", url, "tamanho:", blob.size, "MB:", (blob.size / 1024 / 1024).toFixed(2));
          await idbSet(nsKey(url), blob);
          cachedCount++;
        } catch (err) {
          // Não travar se falhar - apenas logar e continuar
          dlog("erro ao baixar vídeo (continuando):", url, err?.message);
          // Continuar para próximo item sem bloquear
        }
      }
    } catch (err) {
      dlog("precache falhou →", url, err?.message);
    }
  }
}

// ===== Utils =====
function guessContentType(pathname) {
  if (/\.mp4$/i.test(pathname)) return "video/mp4";
  if (/\.webm$/i.test(pathname)) return "video/webm";
  if (/\.mov$/i.test(pathname)) return "video/quicktime";
  if (/\.mkv$/i.test(pathname)) return "video/x-matroska";
  if (/\.avi$/i.test(pathname)) return "video/x-msvideo";
  if (/\.m3u8$/i.test(pathname)) return "application/vnd.apple.mpegurl";
  if (/\.(m4s|ts)$/i.test(pathname)) return "video/mp2t";
  if (/\.jpg$/i.test(pathname) || /\.jpeg$/i.test(pathname)) return "image/jpeg";
  if (/\.png$/i.test(pathname)) return "image/png";
  if (/\.webp$/i.test(pathname)) return "image/webp";
  return "application/octet-stream";
}
