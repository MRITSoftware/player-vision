// player.js
// -------------------------------------------------------
// MRIT Player – vídeo com CORS/Range-friendly + cache por tela
// - cache por código de tela (namespaced)
// - informa namespace ao SW e limpa quando sai de uso
// - remove HEAD em vídeos (evita 403 falsos)
// - seta crossorigin="anonymous" antes de tocar
// - limpa src/load entre trocas
// -------------------------------------------------------

const supabaseUrl = "https://base.muraltv.com.br";
const supabaseKey = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJyb2xlIjoiYW5vbiIsImlzcyI6InN1cGFiYXNlIiwiaWF0IjoxNzUyODA3NjAwLCJleHAiOjE5MTA1NzQwMDB9.P4goMdCvXKPk9ViLYlSUk7nR_zeW3yUw5ixjv7Mk99g";
const client = supabase.createClient(supabaseUrl, supabaseKey);

// ===== Constantes/estado =====
const POLLING_MS = 1000; // 1 segundo para resposta instantânea
let playlist = [];
let currentIndex = 0;
let currentPlaylistId = null;
let codigoAtual = null;
let currentContentCode = null;
let displaysChannel = null;
let playlistChannel = null;
let dispositivosChannel = null;
let dispositivosCheckTimer = null;
let pollTimer = null;
let cacheCheckTimer = null;
let playToken = 0;
let currentItemUrl = null;
let isPlaying = false;
let realtimeReady = false;
let onlineDebounceId = null;
let pendingResync = false;
let videoRetryCount = 0;
const MAX_VIDEO_RETRIES = 3;
let isLoadingVideo = false;
let currentVideoToken = 0;

// ===== Variáveis de promoção =====
let promoData = null;
let promoCounter = null;
let promoPopup = null;

const video = document.getElementById("videoPlayer");
const img = document.getElementById("imgPlayer");

// ===== Constantes para localStorage =====
const CODIGO_DISPLAY_KEY = 'mrit_display_codigo';
const LOCAL_TELA_KEY = 'mrit_local_tela';
const DEVICE_ID_KEY = 'mrit_device_id';

// ===== Gerar ID único do dispositivo =====
function gerarDeviceId() {
  let deviceId = localStorage.getItem(DEVICE_ID_KEY);
  
  if (!deviceId) {
    // Gerar um ID único baseado em características do navegador
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    ctx.textBaseline = 'top';
    ctx.font = '14px "Arial"';
    ctx.textBaseline = 'alphabetic';
    ctx.fillText('Device fingerprint', 2, 2);
    
    const fingerprint = [
      navigator.userAgent,
      navigator.language,
      screen.width + 'x' + screen.height,
      new Date().getTimezoneOffset(),
      canvas.toDataURL()
    ].join('|');
    
    // Criar hash simples do fingerprint
    let hash = 0;
    for (let i = 0; i < fingerprint.length; i++) {
      const char = fingerprint.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash; // Convert to 32bit integer
    }
    
    deviceId = 'device_' + Math.abs(hash).toString(36) + '_' + Date.now().toString(36);
    localStorage.setItem(DEVICE_ID_KEY, deviceId);
    console.log("🆔 Novo ID de dispositivo gerado:", deviceId);
  }
  
  return deviceId;
}

// Garantir que elementos estejam visíveis quando a página carregar
document.addEventListener('DOMContentLoaded', function() {
  ensureElementsVisible();
  
  // Verificar localStorage PRIMEIRO (busca rápida)
  const codigoLocal = localStorage.getItem(CODIGO_DISPLAY_KEY);
  const localLocal = localStorage.getItem(LOCAL_TELA_KEY);
  
  // Se há código salvo, FORÇAR fullscreen imediatamente
  if (codigoLocal && codigoLocal.trim() && localLocal && localLocal.trim()) {
    console.log("🔒 Código salvo detectado no carregamento - FORÇANDO fullscreen");
    setTimeout(() => entrarFullscreen(), 100);
    setTimeout(() => entrarFullscreen(), 400);
    setTimeout(() => entrarFullscreen(), 800);
  }
  
  // Tentar entrar em fullscreen imediatamente se for PWA instalado
  if (window.matchMedia('(display-mode: standalone)').matches || 
      window.navigator.standalone === true ||
      document.referrer.includes('android-app://')) {
    // É um PWA instalado, tentar fullscreen imediatamente
    setTimeout(() => entrarFullscreen(), 100);
  }
  
  // Verificar se já existe um código salvo e iniciar automaticamente
  verificarCodigoSalvo();
});

// ===== Sistema de Notificações =====
function showNotification(message, type = 'error') {
  // Remove notificação existente se houver
  const existingNotification = document.getElementById('notification');
  if (existingNotification) {
    existingNotification.remove();
  }

  // Cria elemento da notificação
  const notification = document.createElement('div');
  notification.id = 'notification';
  notification.textContent = message;
  
  // Estilos da notificação
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

  // Remove após 4 segundos
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

// ===== Função para limpar campo de código =====
function clearCodeField() {
  const codigoField = document.getElementById("codigoTela");
  if (codigoField) {
    codigoField.value = '';
    codigoField.focus();
  }
}

// ===== Função para limpar código salvo =====
function limparCodigoSalvo() {
  localStorage.removeItem(CODIGO_DISPLAY_KEY);
  console.log("🗑️ Código salvo removido do localStorage");
  const codigoField = document.getElementById("codigoTela");
  if (codigoField) {
    codigoField.value = '';
    codigoField.focus();
  }
}

// ===== Função para garantir que elementos estejam visíveis =====
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

// ===== Cache helpers (namespaced por código) =====
function cacheKeyFor(codigo) {
  return `playlist_cache_${codigo}`;
}

// ===== Atualização de Status do Cache =====
async function atualizarStatusCache(codigo, status) {
  if (!codigo || !navigator.onLine) return;
  
  try {
    console.log(`🔄 Atualizando status do cache para ${codigo}: ${status ? 'pronto' : 'não pronto'}`);
    
    const { error } = await client
      .from("displays")
      .update({ cache: status })
      .eq("codigo_unico", codigo);
    
    if (error) {
      console.error("❌ Erro ao atualizar status do cache:", error);
    } else {
      console.log(`✅ Status do cache atualizado: ${status ? 'pronto' : 'não pronto'}`);
    }
  } catch (err) {
    console.error("❌ Erro na conexão ao atualizar cache:", err);
  }
}

// ===== Verificação e Validação do Cache =====
async function verificarEAtualizarStatusCache() {
  if (!codigoAtual || !playlist || playlist.length === 0) {
    await atualizarStatusCache(codigoAtual, false);
    return false;
  }
  
  try {
    console.log("🔍 Verificando se cache está realmente pronto...");
    
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
          console.log(`✅ Vídeo em cache: ${url} (${cachedBlob.size} bytes)`);
        } else {
          videosFaltando.push(url);
          console.log(`❌ Vídeo não em cache: ${url}`);
        }
      } else if (isImage) {
        totalImagens++;
        // Verificar se imagem está no cache do Service Worker
        try {
          const cache = await caches.open("mrit-player-cache-v12");
          const cachedResponse = await cache.match(url);
          
          if (cachedResponse && cachedResponse.ok) {
            imagensEmCache++;
            console.log(`✅ Imagem em cache: ${url}`);
          } else {
            imagensFaltando.push(url);
            console.log(`❌ Imagem não em cache: ${url}`);
          }
        } catch (error) {
          console.log(`⚠️ Erro ao verificar cache da imagem: ${url}`, error);
          imagensFaltando.push(url);
        }
      }
    }
    
    // Calcular percentual de cache
    const percentualVideos = totalVideos > 0 ? (videosEmCache / totalVideos) * 100 : 100;
    const percentualImagens = totalImagens > 0 ? (imagensEmCache / totalImagens) * 100 : 100;
    
    // Cache está pronto se 80% dos vídeos OU 80% das imagens estão em cache
    const cachePronto = percentualVideos >= 80 || percentualImagens >= 80;
    
    console.log(`📊 Cache de Vídeos: ${videosEmCache}/${totalVideos} (${percentualVideos.toFixed(1)}%)`);
    console.log(`📊 Cache de Imagens: ${imagensEmCache}/${totalImagens} (${percentualImagens.toFixed(1)}%)`);
    console.log(`📊 Status: ${cachePronto ? '✅ Pronto' : '❌ Não pronto'}`);
    
    // Se há vídeos faltando, forçar cache direto
    if (videosFaltando.length > 0) {
      console.log("🔄 Vídeos faltando no cache, forçando cache direto...");
      const resultado = await mritDebug.forcarCacheDireto();
      if (resultado && resultado.cachedCount > 0) {
        console.log("✅ Cache direto concluído com sucesso");
        // Verificar novamente após cache direto
        return await verificarEAtualizarStatusCache();
      }
    }
    
    // Se há imagens faltando, forçar cache de imagens
    if (imagensFaltando.length > 0) {
      console.log("🔄 Imagens faltando no cache, forçando cache de imagens...");
      await mritDebug.forcarCacheImagens();
    }
    
    // Atualizar status no banco
    await atualizarStatusCache(codigoAtual, cachePronto);
    
    return cachePronto;
  } catch (error) {
    console.error("❌ Erro ao verificar cache:", error);
    await atualizarStatusCache(codigoAtual, false);
    return false;
  }
}

// ===== Orientation utils =====
let ORIENTATION = "landscape"; // default
function detectOrientation() {
  const so = (screen.orientation && screen.orientation.type) || "";
  if (so.includes("portrait")) return "portrait";
  if (so.includes("landscape")) return "landscape";
  return (window.innerHeight > window.innerWidth) ? "portrait" : "landscape";
}
function applyOrientation(o = detectOrientation()) {
  ORIENTATION = o;
  document.documentElement.dataset.orientation = o; // opcional p/ CSS
}
function setupOrientationWatcher() {
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

// ===== Fit rules por orientação/tipo =====
// FULL SCREEN por padrão: imagem = cover, vídeo = cover.
const FIT_RULES = {
  portrait:  { image: "cover", video: "cover" },
  landscape: { image: "cover", video: "cover" },
};
function applyFit(el, fit = "cover", pos = "center center") {
  el.style.objectFit = fit;
  el.style.objectPosition = pos;
}

// (Opcional) Se tiver urls específicas por orientação no item
function pickSourceForOrientation(item) {
  if (ORIENTATION === "portrait" && item.urlPortrait)  return item.urlPortrait;
  if (ORIENTATION === "landscape" && item.urlLandscape) return item.urlLandscape;
  return item.url;
}

// ===== Player =====
function startPlayer() {
  iniciar();
}

// ===== Função para verificar código salvo =====
async function verificarCodigoSalvo() {
  try {
    const deviceId = gerarDeviceId();
    
    // PRIMEIRO: Verificar localStorage (busca rápida local)
    const codigoLocal = localStorage.getItem(CODIGO_DISPLAY_KEY);
    const localLocal = localStorage.getItem(LOCAL_TELA_KEY);
    
    if (codigoLocal && codigoLocal.trim()) {
      console.log("📦 Código encontrado no localStorage:", codigoLocal);
      
      // Preencher campos imediatamente (feedback visual rápido)
      const codigoField = document.getElementById("codigoTela");
      const localField = document.getElementById("localTela");
      if (codigoField) codigoField.value = codigoLocal.trim().toUpperCase();
      if (localField && localLocal) localField.value = localLocal;
      
      // Tentar fullscreen imediatamente se há código salvo
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
          console.log("📱 Dispositivo encontrado na tabela:", dispositivo);
          
          const codigoDisplay = dispositivo.codigo_display;
          const localNome = dispositivo.local_nome;
          
          // Preencher campos
          const codigoField = document.getElementById("codigoTela");
          const localField = document.getElementById("localTela");
          if (codigoField) codigoField.value = codigoDisplay.trim().toUpperCase();
          if (localField) localField.value = localNome || "";
          
          // Verificar se o display ainda existe e se is_locked permite uso
          const { data: display, error: displayError } = await client
            .from("displays")
            .select("codigo_unico,is_locked")
            .eq("codigo_unico", codigoDisplay)
            .maybeSingle();
          
          if (display) {
            // VERIFICAR: Se o código não está sendo usado por outro dispositivo
            const { data: codigoEmUso } = await client
              .from("dispositivos")
              .select("device_id, local_nome")
              .eq("codigo_display", codigoDisplay)
              .eq("is_ativo", true)
              .maybeSingle();
            
            if (codigoEmUso && codigoEmUso.device_id !== deviceId) {
              // Código está sendo usado por outro dispositivo
              console.log("❌ Código já em uso por outro dispositivo:", codigoEmUso.device_id, "em", codigoEmUso.local_nome);
              showNotification(`Código já está em uso em: ${codigoEmUso.local_nome || 'outro local'}. Uma tela só pode ser usada em um lugar por vez.`);
              
              // Limpar dispositivo (desativar)
              await client
                .from("dispositivos")
                .update({ is_ativo: false })
                .eq("device_id", deviceId);
              
              // Limpar localStorage
              localStorage.removeItem(CODIGO_DISPLAY_KEY);
              localStorage.removeItem(LOCAL_TELA_KEY);
              
              // Limpar campos
              const codigoField = document.getElementById("codigoTela");
              const localField = document.getElementById("localTela");
              if (codigoField) codigoField.value = "";
              if (localField) localField.value = "";
              
              return;
            }
            
            // VERIFICAR: Se is_locked = false, significa que exibição foi parada
            // Nesse caso, NÃO iniciar automaticamente e limpar tudo
            if (display.is_locked === false) {
              console.log("⏸️ Display está desbloqueado (is_locked = false), exibição foi parada");
              
              // Desativar dispositivo
              await client
                .from("dispositivos")
                .update({ is_ativo: false })
                .eq("device_id", deviceId);
              
              // Limpar localStorage
              localStorage.removeItem(CODIGO_DISPLAY_KEY);
              localStorage.removeItem(LOCAL_TELA_KEY);
              
              // Limpar campos
              const codigoField = document.getElementById("codigoTela");
              const localField = document.getElementById("localTela");
              if (codigoField) codigoField.value = "";
              if (localField) localField.value = "";
              
              console.log("🧹 Dispositivo desativado e dados limpos. Aguardando novo código e local.");
              return; // NÃO iniciar automaticamente
            }
            
            // Se is_locked = true, permite usar (tela física pode continuar)
            console.log("✅ Display encontrado, is_locked: true, iniciando automaticamente...");
            
            // Atualizar last_seen e garantir lock
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
                  last_seen: new Date().toISOString()
                })
                .eq("device_id", deviceId);
            } catch (updateErr) {
              console.warn("⚠️ Erro ao atualizar:", updateErr);
            }
            
            // Salvar no localStorage (sincronizar com banco)
            localStorage.setItem(CODIGO_DISPLAY_KEY, codigoDisplay);
            if (localNome) localStorage.setItem(LOCAL_TELA_KEY, localNome);
            console.log("💾 Código e local salvos no localStorage:", codigoDisplay, localNome);
            
            // Esconder elementos de login
            const inputDiv = document.getElementById("codigoInput");
            const rodape = document.getElementById("rodape");
            const logo = document.getElementById("logo");
            if (inputDiv) {
              inputDiv.classList.add("fade-out");
              setTimeout(() => { inputDiv.style.display = "none"; }, 500);
            }
            if (rodape) {
              rodape.classList.add("fade-out");
              setTimeout(() => { rodape.style.display = "none"; }, 500);
            }
            if (logo) {
              logo.classList.add("fade-out");
              setTimeout(() => { logo.style.display = "none"; }, 500);
            }
            
            // FORÇAR fullscreen imediatamente (código salvo = obrigatório fullscreen)
            console.log("🔒 Código e local salvos detectados - FORÇANDO fullscreen obrigatório");
            entrarFullscreen(); // Imediato
            setTimeout(() => entrarFullscreen(), 200);
            setTimeout(() => entrarFullscreen(), 500);
            setTimeout(() => entrarFullscreen(), 1000);
            
            // Iniciar automaticamente
            setTimeout(() => {
              startPlayer();
            }, 1000);
            
            // Continuar tentando fullscreen após iniciar (múltiplas tentativas)
            setTimeout(() => entrarFullscreen(), 1500);
            setTimeout(() => entrarFullscreen(), 2500);
            setTimeout(() => entrarFullscreen(), 4000);
            setTimeout(() => entrarFullscreen(), 6000);
            return;
          } else {
            console.log("❌ Display não encontrado, limpar dispositivo");
            // Display não existe mais, desativar dispositivo
            await client
              .from("dispositivos")
              .update({ is_ativo: false })
              .eq("device_id", deviceId);
          }
        }
      } catch (err) {
        // Se tabela não existir ainda, usar método antigo
        if (err.message && err.message.includes('relation') && err.message.includes('does not exist')) {
          console.log("ℹ️ Tabela dispositivos ainda não criada, usando método antigo");
        } else {
          console.error("Erro ao buscar dispositivo:", err);
        }
      }
    }
    
    // FALLBACK: Método antigo (localStorage) - retrocompatibilidade
    const codigoSalvo = localStorage.getItem(CODIGO_DISPLAY_KEY);
    
    if (codigoSalvo && codigoSalvo.trim()) {
      console.log("📱 Código salvo encontrado (localStorage):", codigoSalvo);
      
      // Preencher o campo com o código salvo
      const codigoField = document.getElementById("codigoTela");
      const localField = document.getElementById("localTela");
      if (codigoField) {
        codigoField.value = codigoSalvo.trim().toUpperCase();
      }
      const localSalvo = localStorage.getItem(LOCAL_TELA_KEY);
      if (localField && localSalvo) {
        localField.value = localSalvo;
      }
      
      // Verificar se o código ainda é válido no banco
      if (navigator.onLine) {
        try {
          // Buscar código com device_id para verificar se é o mesmo dispositivo
          let { data: tela, error } = await client
            .from("displays")
            .select("codigo_unico,is_locked,device_id")
            .eq("codigo_unico", codigoSalvo.trim().toUpperCase())
            .maybeSingle();
          
          // Se não encontrou device_id na primeira query, tentar sem ele (retrocompatibilidade)
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
            // Verificar se é o mesmo dispositivo (mesmo device_id)
            const mesmoDispositivo = tela.device_id && tela.device_id === deviceId;
            
            // Permitir se: não está locked OU se está locked mas é o mesmo dispositivo
            if (!tela.is_locked || mesmoDispositivo) {
              console.log("✅ Código válido", mesmoDispositivo ? "(mesmo dispositivo)" : "(não está em uso)", "iniciando automaticamente...");
              
              // Atualizar device_id e last_seen
              try {
                await client
                  .from("displays")
                  .update({ 
                    device_id: deviceId,
                    device_last_seen: new Date().toISOString(),
                    is_locked: true,  // Garantir que está locked
                    status: "Em uso"
                  })
                  .eq("codigo_unico", codigoSalvo.trim().toUpperCase());
              } catch (updateErr) {
                // Ignorar erros silenciosamente se campos não existirem
                if (updateErr.message && updateErr.message.includes('column') && updateErr.message.includes('does not exist')) {
                  // Campo não existe ainda - normal, ignorar
                } else {
                  console.warn("⚠️ Erro ao atualizar device_id:", updateErr);
                }
              }
              
              setTimeout(() => {
                startPlayer();
              }, 1000);
              return;
            } else {
              // Está locked E não é o mesmo dispositivo
              console.log("⚠️ Código está em uso por outro dispositivo");
              showNotification("Código em uso por outro dispositivo. Aguarde ou insira outro código.");
              // Limpar código salvo se estiver em uso por outro dispositivo
              localStorage.removeItem(CODIGO_DISPLAY_KEY);
              if (codigoField) codigoField.value = "";
              return;
            }
          } else {
            console.log("❌ Código não encontrado no banco, limpar salvamento");
            localStorage.removeItem(CODIGO_DISPLAY_KEY);
            if (codigoField) codigoField.value = "";
            showNotification("Código salvo não é mais válido. Insira um novo código.");
            return;
          }
        } catch (err) {
          console.error("Erro ao verificar código no banco:", err);
          // Em caso de erro, manter o código salvo mas não iniciar automaticamente
          showNotification("Erro ao verificar código. Verifique sua conexão.");
        }
      } else {
        // Offline: usar código salvo mesmo sem verificação
        console.log("📴 Modo offline, usando código salvo");
        setTimeout(() => {
          startPlayer();
        }, 1000);
      }
    } else {
      console.log("📝 Nenhum código salvo encontrado, aguardando entrada do usuário");
    }
  } catch (err) {
    console.error("Erro ao verificar código salvo:", err);
  }
}

async function iniciar() {
  setupOrientationWatcher();

  const codigo = document.getElementById("codigoTela").value.trim().toUpperCase();
  const local = document.getElementById("localTela").value.trim();
  
  if (!codigo) {
    showNotification("Informe o código do display!");
    ensureElementsVisible();
    return;
  }
  
  if (!local) {
    showNotification("Informe o local da tela!");
    ensureElementsVisible();
    return;
  }
  
  // NÃO definir codigoAtual ainda - só depois de validar
  
  // VALIDAÇÃO PRIMEIRO: Verificar se código já está em uso ANTES de fazer qualquer coisa
  if (navigator.onLine) {
    try {
      const deviceId = gerarDeviceId();
      console.log("🔍 Device ID:", deviceId);
      console.log("🔗 Verificando se código já está em uso...");
      
      // VERIFICAR PRIMEIRO: Se o código já está sendo usado por outro dispositivo
      const { data: codigoEmUso, error: checkError } = await client
        .from("dispositivos")
        .select("device_id, local_nome, is_ativo")
        .eq("codigo_display", codigo)
        .eq("is_ativo", true)
        .maybeSingle();
      
      console.log("📊 Resultado da verificação:", codigoEmUso);
      
      if (checkError) {
        // Se tabela não existir, ignorar (retrocompatibilidade)
        if (checkError.message && checkError.message.includes('relation') && checkError.message.includes('does not exist')) {
          console.log("ℹ️ Tabela dispositivos ainda não criada (opcional)");
        } else {
          console.error("❌ Erro ao verificar código:", checkError);
          showNotification("Erro ao verificar código. Tente novamente.");
          clearCodeField();
          ensureElementsVisible();
          return;
        }
      } else if (codigoEmUso) {
        // Verificar se é o mesmo dispositivo
        if (codigoEmUso.device_id !== deviceId) {
          // Código já está sendo usado por OUTRO dispositivo
          console.error("❌ BLOQUEADO: Código já em uso por outro dispositivo");
          console.log("   Device ID atual:", deviceId);
          console.log("   Device ID em uso:", codigoEmUso.device_id);
          console.log("   Local em uso:", codigoEmUso.local_nome);
          showNotification(`❌ Código já está em uso em: ${codigoEmUso.local_nome || 'outro local'}. Uma tela só pode ser usada em um lugar por vez.`);
          clearCodeField();
          ensureElementsVisible();
          return; // BLOQUEAR - não continua
        } else {
          console.log("✅ Mesmo dispositivo, permitindo continuar");
        }
      } else {
        console.log("✅ Código livre, pode usar");
      }
    } catch (err) {
      console.error("❌ Erro na validação:", err);
      showNotification("Erro ao validar código. Tente novamente.");
      clearCodeField();
      ensureElementsVisible();
      return;
    }
  }
  
  // Se chegou aqui, código está livre ou é o mesmo dispositivo - pode continuar
  codigoAtual = codigo;
  
  // Salvar código e local no localStorage para uso futuro
  localStorage.setItem(CODIGO_DISPLAY_KEY, codigo);
  localStorage.setItem(LOCAL_TELA_KEY, local);
  console.log("💾 Código e local salvos no localStorage:", codigo, local);
  
  // Salvar na tabela dispositivos (nova tabela)
  if (navigator.onLine) {
    try {
      const deviceId = gerarDeviceId();
      
      // Se chegou aqui, código está livre ou é o mesmo dispositivo
      console.log("🔗 Salvando dispositivo na tabela dispositivos...");
      
      // VERIFICAÇÃO DUPLA: Verificar novamente antes de salvar (evitar race condition)
      const { data: verificarDuplo } = await client
        .from("dispositivos")
        .select("device_id, local_nome")
        .eq("codigo_display", codigo)
        .eq("is_ativo", true)
        .maybeSingle();
      
      if (verificarDuplo && verificarDuplo.device_id !== deviceId) {
        console.error("❌ BLOQUEADO: Código foi ocupado enquanto processava (race condition)");
        console.log("   Device ID atual:", deviceId);
        console.log("   Device ID que ocupou:", verificarDuplo.device_id);
        showNotification(`❌ Código foi ocupado por outro dispositivo em: ${verificarDuplo.local_nome || 'outro local'}. Tente novamente.`);
        clearCodeField();
        ensureElementsVisible();
        return;
      }
      
      // Verificar se dispositivo já existe
      const { data: dispositivoExistente } = await client
        .from("dispositivos")
        .select("id, codigo_display")
        .eq("device_id", deviceId)
        .maybeSingle();
      
      if (dispositivoExistente) {
        // Se dispositivo existente estava usando outro código, liberar o código antigo
        if (dispositivoExistente.codigo_display && dispositivoExistente.codigo_display !== codigo) {
          console.log("🔄 Dispositivo estava usando outro código, liberando:", dispositivoExistente.codigo_display);
          
          // Desativar o uso do código antigo por este dispositivo
          await client
            .from("dispositivos")
            .update({ is_ativo: false })
            .eq("device_id", deviceId)
            .eq("codigo_display", dispositivoExistente.codigo_display);
        }
        
        // Atualizar dispositivo existente com NOVO código
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
          console.error("❌ Erro ao atualizar dispositivo:", updateError);
          showNotification("Erro ao atualizar dispositivo. Tente novamente.");
          clearCodeField();
          ensureElementsVisible();
          return;
        } else {
          console.log("✅ Dispositivo atualizado na tabela");
        }
      } else {
        // Criar novo dispositivo - mas verificar novamente antes de inserir (race condition)
        const { data: verificarNovamente } = await client
          .from("dispositivos")
          .select("device_id, local_nome")
          .eq("codigo_display", codigo)
          .eq("is_ativo", true)
          .maybeSingle();
        
        if (verificarNovamente && verificarNovamente.device_id !== deviceId) {
          console.error("❌ BLOQUEADO: Código foi ocupado enquanto processava (race condition)");
          console.log("   Device ID atual:", deviceId);
          console.log("   Device ID que ocupou:", verificarNovamente.device_id);
          showNotification(`❌ Código foi ocupado por outro dispositivo em: ${verificarNovamente.local_nome || 'outro local'}. Tente novamente.`);
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
          // Se tabela não existir, ignorar (retrocompatibilidade)
          if (insertError.message && insertError.message.includes('relation') && insertError.message.includes('does not exist')) {
            console.log("ℹ️ Tabela dispositivos ainda não criada (opcional)");
          } else {
            console.error("❌ Erro ao criar dispositivo:", insertError);
            showNotification("Erro ao criar dispositivo. Tente novamente.");
            clearCodeField();
            ensureElementsVisible();
            return;
          }
        } else {
          console.log("✅ Dispositivo criado na tabela");
          
          // VERIFICAÇÃO FINAL: Confirmar que realmente salvou e não há conflito
          const { data: confirmacao } = await client
            .from("dispositivos")
            .select("device_id")
            .eq("codigo_display", codigo)
            .eq("is_ativo", true)
            .maybeSingle();
          
          if (confirmacao && confirmacao.device_id !== deviceId) {
            console.error("❌ CONFLITO DETECTADO: Outro dispositivo ocupou o código após salvar");
            // Remover este dispositivo
            await client
              .from("dispositivos")
              .update({ is_ativo: false })
              .eq("device_id", deviceId);
            
            showNotification("❌ Código foi ocupado por outro dispositivo. Tente novamente.");
            clearCodeField();
            ensureElementsVisible();
            return;
          }
        }
      }
    } catch (err) {
      // Se tabela não existir, ignorar (retrocompatibilidade)
      if (err.message && err.message.includes('relation') && err.message.includes('does not exist')) {
        console.log("ℹ️ Tabela dispositivos ainda não criada (opcional)");
      } else {
        console.error("❌ Erro ao salvar dispositivo:", err);
        showNotification("Erro ao salvar dispositivo. Tente novamente.");
        clearCodeField();
        ensureElementsVisible();
        return;
      }
    }
    
    // Também atualizar displays (método antigo - retrocompatibilidade)
    try {
      const deviceId = gerarDeviceId();
      try {
        const { error } = await client
          .from("displays")
          .update({ 
            device_id: deviceId,
            device_last_seen: new Date().toISOString()
          })
          .eq("codigo_unico", codigo);
        
        if (error) {
          if (error.message && error.message.includes('column') && error.message.includes('does not exist')) {
            // Campos não existem - ok
          } else {
            console.warn("⚠️ Erro ao salvar device_id no displays:", error);
          }
        }
      } catch (updateErr) {
        if (updateErr.message && updateErr.message.includes('column') && updateErr.message.includes('does not exist')) {
          // Campos não existem - ok
        } else {
          console.warn("⚠️ Erro ao vincular dispositivo:", updateErr);
        }
      }
    } catch (err) {
      // Ignorar
    }
  }

  // Reset agressivo ao trocar de código (garante que nada da sessão anterior vaze)
  await resetAllCachesForNewCode();

  if (!navigator.onLine) {
    const cache = localStorage.getItem(cacheKeyFor(codigo));
    if (cache) {
      const data = JSON.parse(cache);
      playlist = data.playlist;
      currentPlaylistId = data.codigo;
      document.getElementById("codigoInput").style.display = "none";
      console.log("📦 Modo offline - usando cache da playlist:", playlist.length, "itens");
      tocarLoop();
      return;
    } else {
      showNotification("Sem internet e nenhum cache disponível para esta tela.");
      clearCodeField();
      ensureElementsVisible();
      return;
    }
  }

  try {
    const deviceId = gerarDeviceId();
    
    // Buscar tela com device_id para verificar se é o mesmo dispositivo
    let { data: tela, error } = await client
      .from("displays")
      .select("codigo_unico,is_locked,codigo_conteudoAtual,device_id")
      .eq("codigo_unico", codigo)
      .maybeSingle();
    
    // Se não encontrou device_id, tentar sem ele (retrocompatibilidade)
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
      showNotification("Tela não encontrada!");
      clearCodeField();
      ensureElementsVisible();
      return;
    }
    
    // Verificar se é o mesmo dispositivo
    const mesmoDispositivo = tela.device_id && tela.device_id === deviceId;
    
    // Verificar se a tela está locked - se estiver E não for o mesmo dispositivo, não permitir
    if (tela.is_locked && !mesmoDispositivo) {
      showNotification("Tela já em uso por outro dispositivo! Por favor, insira outro código.");
      clearCodeField();
      ensureElementsVisible();
      return;
    }

    // Atualizar: lock, device_id e status
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
        .eq("codigo_unico", tela.codigo_unico);
    } catch (updateErr) {
      // Se campos não existirem, fazer update sem eles
      if (updateErr.message && updateErr.message.includes('column') && updateErr.message.includes('does not exist')) {
        await client
          .from("displays")
          .update({ is_locked: true, status: "Em uso" })
          .eq("codigo_unico", tela.codigo_unico);
      } else {
        throw updateErr;
      }
    }

    // Entrar em fullscreen apenas após validação bem-sucedida
    setTimeout(() => entrarFullscreen(), 500);

    // Animar saída dos elementos da interface
    const inputDiv = document.getElementById("codigoInput");
    const rodape = document.getElementById("rodape");
    const logo = document.getElementById("logo");

    inputDiv.classList.add("fade-out");
    rodape.classList.add("fade-out");
    logo.classList.add("fade-out");

    // informa o namespace (código da tela) ao service worker
    if ('serviceWorker' in navigator && navigator.serviceWorker.controller) {
      navigator.serviceWorker.controller.postMessage({
        action: "setNamespace",
        namespace: codigoAtual
      });
    }

    // Esconder elementos após animação
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

    if (pollTimer) clearInterval(pollTimer);
    pollTimer = setInterval(checarLockEConteudo, POLLING_MS);
    
  // Verificação periódica do cache (a cada 60 segundos)
  if (cacheCheckTimer) clearInterval(cacheCheckTimer);
  cacheCheckTimer = setInterval(async () => {
    if (codigoAtual && playlist && playlist.length > 0) {
      await verificarEAtualizarStatusCache();
    }
  }, 60000);

    // Verificar promoção após carregar conteúdo
    await verificarPromocao();
  } catch (err) {
    console.error(err);
    showNotification("Erro na conexão com o banco");
    clearCodeField();
    ensureElementsVisible();
  }
}

async function carregarConteudo(codigoConteudo) {
  try {
    const wasPlaying = !video.paused && video.style.display === "block";
    const currentTime = video.currentTime;
    const wasVideo = video.style.display === "block";
    const currentUrl = currentItemUrl;

    // Conteúdo único
    let { data: conteudo } = await client
      .from("conteudos")
      .select("*")
      .eq("codigoAnuncio", codigoConteudo)
      .maybeSingle();

    if (conteudo) {
      const isImageType =
        (conteudo.tipo || "").toLowerCase() === "imagem" ||
        /\.(jpg|jpeg|png|webp)(\?|$)/i.test(conteudo.url);

      const newPlaylist = [{
        url: conteudo.url,
        tipo: conteudo.tipo,
        duration: isImageType ? 0 : null, // imagem única fica estática
        fit: conteudo.fit ?? null,
        focus: conteudo.focus ?? null,
        urlPortrait: conteudo.urlPortrait ?? null,
        urlLandscape: conteudo.urlLandscape ?? null,
      }];

      currentPlaylistId = null; // indica conteúdo único
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

    const newPlaylist = (itens || []).map(item => ({
      url: item.url,
      tipo: item.tipo || "Vídeo",
      duration: item.tipo?.toLowerCase() === "imagem" ? 15000 : null,
      fit: item.fit ?? null,
      focus: item.focus ?? null,
      urlPortrait: item.urlPortrait ?? null,
      urlLandscape: item.urlLandscape ?? null,
    }));

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

async function atualizarPlaylist(newPlaylist, playlistId, estadoAnterior = {}) {
  const {
    wasPlaying = false,
    currentTime = 0,
    wasVideo = false,
    currentUrl = null,
  } = estadoAnterior;

  // Detectar se a playlist mudou comparando URLs
  const playlistAntiga = Array.isArray(playlist) ? playlist : [];
  const playlistNova = Array.isArray(newPlaylist) ? newPlaylist : [];
  
  // Normalizar URLs para comparação (extrair apenas URLs principais, ordenar e remover espaços)
  const extrairUrls = (items) => {
    const urls = [];
    for (const item of items) {
      const url = pickSourceForOrientation(item);
      if (url) urls.push(url.trim());
    }
    return urls.sort();
  };
  
  const urlsAntigas = extrairUrls(playlistAntiga);
  const urlsNovas = extrairUrls(playlistNova);
  
  // Comparar arrays de URLs ordenadas
  const playlistMudou = urlsAntigas.length !== urlsNovas.length ||
    urlsAntigas.join('|') !== urlsNovas.join('|');

  playlist = Array.isArray(newPlaylist) ? newPlaylist : [];
  currentPlaylistId = playlistId ?? null;
  
  // Se a playlist mudou, limpar cache antigo antes de salvar o novo
  if (playlistMudou && codigoAtual) {
    console.log("🔄 Playlist mudou, limpando cache antigo...");
    console.log(`📊 Antes: ${playlistAntiga.length} itens | Depois: ${playlistNova.length} itens`);
    // Limpar cache de vídeos do IndexedDB
    try {
      const keys = await idbAllKeys();
      const prefix = `${codigoAtual}::`;
      for (const key of keys) {
        if (String(key).startsWith(prefix)) {
          await idbDel(key);
        }
      }
      console.log("✅ Cache de vídeos antigo limpo");
    } catch (error) {
      console.error("❌ Erro ao limpar cache antigo:", error);
    }
    
    // Limpar cache de imagens do Service Worker
    try {
      const cache = await caches.open("mrit-player-cache-v12");
      const keys = await cache.keys();
      for (const req of keys) {
        await cache.delete(req);
      }
      console.log("✅ Cache de imagens antigo limpo");
    } catch (error) {
      console.error("❌ Erro ao limpar cache de imagens:", error);
    }
    
    // Marcar cache como não pronto para forçar recache
    await atualizarStatusCache(codigoAtual, false);
  } else if (codigoAtual && playlistAntiga.length > 0) {
    console.log("✅ Playlist não mudou, mantendo cache existente");
  }
  
  await salvarCache(playlist, (playlistId ?? codigoAtual));

  if (!playlist.length) {
    try { video.pause(); } catch {}
    destroyHls();
    if (img.timeoutId) { clearTimeout(img.timeoutId); delete img.timeoutId; }
    isPlaying = false;
    video.style.display = "none";
    img.style.display = "none";
    currentItemUrl = null;
    currentIndex = 0;
    // Playlist vazia = cache não pronto
    await atualizarStatusCache(codigoAtual, false);
    return;
  }
  
  // Verificar se cache está pronto após mudança na playlist
  setTimeout(async () => {
    console.log("🔄 Verificando cache após mudança na playlist...");
    await verificarEAtualizarStatusCache();
  }, 5000); // Aguardar 5 segundos para cache ser processado
  
  // Forçar cache se Service Worker não estiver disponível
  if (!navigator.serviceWorker.controller) {
    console.log("⚠️ Service Worker não disponível, forçando cache direto...");
    setTimeout(async () => {
      await mritDebug.forcarCacheDireto();
    }, 5000);
  } else {
    // Se Service Worker está disponível, aguardar um pouco e verificar se cache funcionou
    setTimeout(async () => {
      console.log("🔄 Verificando se cache automático funcionou...");
      const cachePronto = await verificarEAtualizarStatusCache();
      if (!cachePronto) {
        console.log("⚠️ Cache automático falhou, forçando cache direto...");
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

  // Item atual não existe mais na playlist (foi removido ou playlist mudou)
  // Limpar estado de reprodução completamente
  try { video.pause(); } catch {}
  destroyHls();
  if (img.timeoutId) { clearTimeout(img.timeoutId); delete img.timeoutId; }
  isPlaying = false;
  currentItemUrl = null;
  
  // Garantir que currentIndex esteja dentro dos limites válidos
  // Se o item atual foi removido, avançar para o próximo item válido
  if (playlist.length > 0) {
    // Se currentIndex estava além do fim ou no último item que foi removido
    if (currentIndex >= playlist.length) {
      // Voltar para o início
      currentIndex = 0;
    } else if (currentIndex < 0) {
      // Se estava negativo, voltar para o início
      currentIndex = 0;
    }
    // currentIndex agora está garantidamente dentro dos limites [0, playlist.length-1]
    
    console.log(`🔄 Item atual removido, continuando do índice ${currentIndex} de ${playlist.length} itens`);
    
    // Pequeno delay para garantir que o estado foi limpo antes de continuar
    setTimeout(() => {
      tocarLoop();
    }, 100);
  } else {
    // Playlist vazia, já foi tratado acima
    console.log("⚠️ Playlist vazia após remoção");
  }
}

async function salvarCache(playlistData, codigo) {
  // cache namespaced por código
  localStorage.setItem(cacheKeyFor(codigo), JSON.stringify({ playlist: playlistData, codigo }));

  if ('serviceWorker' in navigator && navigator.serviceWorker.controller) {
    console.log("📤 Enviando playlist para Service Worker:", playlistData.length, "itens");
    navigator.serviceWorker.controller.postMessage({
      action: "updateCache",
      playlist: playlistData
    });
  } else {
    console.warn("⚠️ Service Worker não disponível para cache automático");
  }
  
  // Atualizar status do cache na tabela displays
  await atualizarStatusCache(codigo, true);
}

// Reset agressivo quando entra com um novo código
async function resetAllCachesForNewCode() {
  // limpa caches antigos de playlists (todas as telas)
  Object.keys(localStorage).forEach(k => {
    if (k.startsWith("playlist_cache_")) localStorage.removeItem(k);
  });

  // pede para o SW limpar qualquer namespace ainda ativo (se houver)
  navigator.serviceWorker?.controller?.postMessage({ action: "clearNamespace" });

  // zera os elementos de mídia
  try { video.pause(); } catch {}
  video.removeAttribute("src");
  video.load();
  img.src = "";
  
  // Marcar cache como não pronto ao trocar de código
  if (codigoAtual) {
    await atualizarStatusCache(codigoAtual, false);
  }
}

async function tocarLoop() {
  if (!playlist.length) {
    video.style.display = "none";
    img.style.display = "none";
    isPlaying = false;
    isLoadingVideo = false;
    return;
  }

  if (isLoadingVideo) {
    isLoadingVideo = false; // reseta se ficou preso
  }

  if (img.timeoutId) { clearTimeout(img.timeoutId); delete img.timeoutId; }
  video.onended = null;
  img.onload = null;
  img.onerror = null;

  currentIndex = currentIndex % playlist.length;
  const item = playlist[currentIndex];
  if (!item || !item.url) { proximoItem(); return; }

  const itemUrl = pickSourceForOrientation(item);
  currentItemUrl = itemUrl;

  const isHls = /\.m3u8(\?|$)/i.test(itemUrl);
  const isVideo = isHls ||
    (item.tipo || "").toLowerCase().includes("vídeo") ||
    (item.tipo || "").toLowerCase().includes("video") ||
    /\.(mp4|webm|mkv|mov|avi|m4v|3gp|flv|wmv)(\?|$)/i.test(itemUrl);

  // esconde ambos
  video.style.display = "none";
  img.style.display = "none";
  // zerar completamente o elemento de vídeo
  try { video.pause(); } catch {}
  video.removeAttribute("src");
  video.load();

  img.src = "";

  const myToken = ++playToken;
  const duration = (item.duration !== undefined) ? item.duration : (isVideo ? null : 15000);

  if (isVideo) {
    // Guard contra carregamentos concorrentes
    if (isLoadingVideo) {
      setTimeout(() => tocarLoop(), 1500);
      return;
    }
    isLoadingVideo = true;
    currentVideoToken++;
    const videoToken = currentVideoToken;

    // Timeout adaptativo baseado na velocidade de rede detectada
    // Usar timeout maior se internet lenta foi detectada anteriormente
    const safetyTimeoutMs = networkSpeed === 'slow' ? 45000 : networkSpeed === 'fast' ? 10000 : 15000;
    const safetyTimeout = setTimeout(() => {
      if (isLoadingVideo) {
        console.warn("⚠️ Timeout de segurança no carregamento de vídeo (", safetyTimeoutMs, "ms, velocidade:", networkSpeed, ")");
        isLoadingVideo = false;
      }
    }, safetyTimeoutMs);
    
    // Detectar velocidade em background para próxima vez (não bloqueia)
    detectNetworkSpeed().catch(() => {});

    try {
      if (isHls) {
        // ---- HLS ----
        destroyHls();
        // Safari/iOS suporta nativo
        if (video.canPlayType('application/vnd.apple.mpegurl')) {
          video.setAttribute("crossorigin", "anonymous");
          video.preload = "auto";
          video.src = itemUrl;
          video.load();

          // Timeout adaptativo para internet lenta (usa velocidade já detectada)
          const hlsTimeout = networkSpeed === 'slow' ? 12000 : networkSpeed === 'fast' ? 3000 : 4000;
          const ok = await waitForCanPlay(video, hlsTimeout);
          if (myToken !== playToken || videoToken !== currentVideoToken) { isLoadingVideo = false; clearTimeout(safetyTimeout); return; }
          if (!ok) { 
            console.warn("⚠️ Vídeo não ficou pronto a tempo (timeout:", hlsTimeout, "ms)");
            isLoadingVideo = false; 
            clearTimeout(safetyTimeout); 
            // Tentar próximo item apenas se não for internet lenta (pode ser só demorado)
            if (networkSpeed !== 'slow') {
              proximoItem(); 
            } else {
              // Internet lenta: tentar novamente após um delay
              console.log("⏳ Internet lenta detectada, aguardando mais um pouco antes de tentar próximo item...");
              setTimeout(() => tocarLoop(), 2000);
            }
            return; 
          }

          const fit  = item.fit   || (FIT_RULES[ORIENTATION]?.video || "cover");
          const focus = item.focus || "center center";
          applyFit(video, fit, focus);

            fadeOut(img, () => {
              fadeIn(video);
              isPlaying = true;
              videoRetryCount = 0;
              isLoadingVideo = false;
              clearTimeout(safetyTimeout);
              video.play().catch((e) => {
                console.error("Erro play HLS:", e);
                video.muted = true;
                video.play().catch(() => proximoItem());
              });
              
              // Tentar fullscreen quando vídeo HLS começar a tocar (múltiplas tentativas)
              setTimeout(() => entrarFullscreen(), 500);
              setTimeout(() => entrarFullscreen(), 1500);
              setTimeout(() => entrarFullscreen(), 3000);
            });
        } else if (window.Hls && window.Hls.isSupported()) {
          hls = new Hls({ maxBufferLength: 30, maxMaxBufferLength: 60 });
          hls.loadSource(itemUrl);
          hls.attachMedia(video);
          hls.on(Hls.Events.MANIFEST_PARSED, () => {
            if (myToken !== playToken || videoToken !== currentVideoToken) return;

            video.setAttribute("crossorigin", "anonymous");
            video.preload = "auto";

            const fit  = item.fit   || (FIT_RULES[ORIENTATION]?.video || "cover");
            const focus = item.focus || "center center";
            applyFit(video, fit, focus);

            fadeOut(img, () => {
              fadeIn(video);
              isPlaying = true;
              videoRetryCount = 0;
              isLoadingVideo = false;
              clearTimeout(safetyTimeout);
              video.play().catch(() => { video.muted = true; video.play(); });
            });
          });
          hls.on(Hls.Events.ERROR, (evt, data) => {
            if (data.fatal) {
              switch (data.type) {
                case Hls.ErrorTypes.NETWORK_ERROR: hls.startLoad(); break;
                case Hls.ErrorTypes.MEDIA_ERROR:   hls.recoverMediaError(); break;
                default:
                  destroyHls(); isLoadingVideo = false; clearTimeout(safetyTimeout); proximoItem();
              }
            }
          });
        } else {
          // fallback direto
          video.setAttribute("crossorigin", "anonymous");
          video.preload = "auto";
          video.src = itemUrl;
          video.load();

          // Timeout adaptativo para internet lenta (usa velocidade já detectada)
          const hlsTimeout = networkSpeed === 'slow' ? 12000 : networkSpeed === 'fast' ? 3000 : 4000;
          const ok = await waitForCanPlay(video, hlsTimeout);
          if (myToken !== playToken || videoToken !== currentVideoToken) { isLoadingVideo = false; clearTimeout(safetyTimeout); return; }
          if (!ok) { 
            console.warn("⚠️ Vídeo não ficou pronto a tempo (timeout:", hlsTimeout, "ms)");
            isLoadingVideo = false; 
            clearTimeout(safetyTimeout); 
            // Tentar próximo item apenas se não for internet lenta (pode ser só demorado)
            if (networkSpeed !== 'slow') {
              proximoItem(); 
            } else {
              // Internet lenta: tentar novamente após um delay
              console.log("⏳ Internet lenta detectada, aguardando mais um pouco antes de tentar próximo item...");
              setTimeout(() => tocarLoop(), 2000);
            }
            return; 
          }

          const fit  = item.fit   || (FIT_RULES[ORIENTATION]?.video || "cover");
          const focus = item.focus || "center center";
          applyFit(video, fit, focus);

          fadeOut(img, () => {
            fadeIn(video);
            isPlaying = true;
            videoRetryCount = 0;
            isLoadingVideo = false;
            clearTimeout(safetyTimeout);
            video.play().catch(() => { video.muted = true; video.play(); });
          });
        }
      } else {
        // ---- MP4/WebM/etc (sem HEAD) ----
        // limpa e seta atributos antes do src
        video.setAttribute("crossorigin", "anonymous");
        video.preload = "auto";

        // Verificar se estamos offline e se o vídeo está no cache
        if (!navigator.onLine) {
          try {
            const cacheKey = `${codigoAtual}::${itemUrl}`;
            const cachedBlob = await idbGet(cacheKey);
            
            if (cachedBlob) {
              console.log("📦 Carregando vídeo do cache offline:", itemUrl);
              // Criar URL do blob para o vídeo
              const blobUrl = URL.createObjectURL(cachedBlob);
              video.src = blobUrl;
              video.load();
              
              // Limpar URL do blob quando o vídeo terminar
              video.addEventListener('ended', () => {
                URL.revokeObjectURL(blobUrl);
              }, { once: true });
              
              const ok = await waitForCanPlay(video, 8000);
              if (myToken !== playToken || videoToken !== currentVideoToken) { 
                URL.revokeObjectURL(blobUrl);
                isLoadingVideo = false; 
                clearTimeout(safetyTimeout); 
                return; 
              }
              if (!ok || video.readyState < 3) {
                console.error("Vídeo do cache não ficou pronto (readyState:", video.readyState, ")");
                URL.revokeObjectURL(blobUrl);
                isLoadingVideo = false; 
                clearTimeout(safetyTimeout); 
                proximoItem(); 
                return;
              }
            } else {
              console.warn("⚠️ Vídeo não encontrado no cache offline:", itemUrl);
              isLoadingVideo = false; 
              clearTimeout(safetyTimeout); 
              proximoItem(); 
              return;
            }
          } catch (error) {
            console.error("Erro ao carregar vídeo do cache:", error);
            isLoadingVideo = false; 
            clearTimeout(safetyTimeout); 
            proximoItem(); 
            return;
          }
        } else {
          // aplicar src e carregar normalmente quando online
          video.src = itemUrl;
          video.load();

          // Timeout adaptativo para internet lenta (usa velocidade já detectada)
          const mp4Timeout = networkSpeed === 'slow' ? 24000 : networkSpeed === 'fast' ? 6000 : 8000;
          const ok = await waitForCanPlay(video, mp4Timeout);
          if (myToken !== playToken || videoToken !== currentVideoToken) { isLoadingVideo = false; clearTimeout(safetyTimeout); return; }
          if (!ok || video.readyState < 3) {
            console.warn("⚠️ Vídeo não ficou pronto (readyState:", video.readyState, ", timeout:", mp4Timeout, "ms)");
            isLoadingVideo = false; 
            clearTimeout(safetyTimeout);
            // Se internet lenta, aguardar mais antes de desistir
            if (networkSpeed === 'slow' && video.readyState >= 2) {
              console.log("⏳ Internet lenta detectada, aguardando mais um pouco...");
              setTimeout(() => {
                if (video.readyState >= 3) {
                  // Vídeo ficou pronto, continuar
                  const fit = item.fit || (FIT_RULES[ORIENTATION]?.video || "cover");
                  const focus = item.focus || "center center";
                  applyFit(video, fit, focus);
                  fadeOut(img, () => {
                    fadeIn(video);
                    isPlaying = true;
                    videoRetryCount = 0;
                    isLoadingVideo = false;
                    clearTimeout(safetyTimeout);
                    video.play().catch((playError) => {
                      console.error("Erro ao reproduzir vídeo:", playError);
                      video.muted = true;
                      video.play().catch(() => {
                        isLoadingVideo = false;
                        clearTimeout(safetyTimeout);
                        proximoItem();
                      });
                    });
                  });
                } else {
                  proximoItem();
                }
              }, 3000);
              return;
            }
            proximoItem(); 
            return;
          }
        }

        const fit  = item.fit   || (FIT_RULES[ORIENTATION]?.video || "cover");
        const focus = item.focus || "center center";
        applyFit(video, fit, focus);

        fadeOut(img, () => {
          fadeIn(video);
          isPlaying = true;
          videoRetryCount = 0;
          isLoadingVideo = false;
          clearTimeout(safetyTimeout);
          video.play().catch((playError) => {
            console.error("Erro ao reproduzir vídeo:", playError);
            video.muted = true;
            video.play().catch(() => {
              isLoadingVideo = false;
              clearTimeout(safetyTimeout);
              proximoItem();
            });
          });
        });
      }

      video.onended = async () => {
        isPlaying = false;
        
        // Verificar código ao final do vídeo
        const mudou = await verificarCodigoDispositivoAoCiclo();
        if (mudou) {
          return; // Se mudou, carregarConteudo já foi chamado
        }
        
        if (pendingResync) {
          pendingResync = false;
          await carregarConteudo(currentPlaylistId || codigoAtual);
        }
        proximoItem();
      };
    } catch (e) {
      console.error("Erro no vídeo:", e, "URL:", itemUrl, "tipo:", item.tipo);
      isLoadingVideo = false;
      clearTimeout(safetyTimeout);

      if (videoRetryCount < MAX_VIDEO_RETRIES) {
        videoRetryCount++;
        setTimeout(() => tocarLoop(), 1500);
        return;
      }
      videoRetryCount = 0;
      isPlaying = false;
      proximoItem();
    }
  } else {
    // ---- IMAGEM ----
    img.onload = () => {
      if (myToken !== playToken) return;

      const fit   = item.fit   || (FIT_RULES[ORIENTATION]?.image || "cover");
      const focus = item.focus || "center center";
      applyFit(img, fit, focus);

      fadeOut(video, () => {
        fadeIn(img);
        isPlaying = true;

        if (typeof duration === "number" && duration > 0) {
          img.timeoutId = setTimeout(async () => {
            isPlaying = false;
            
            // Verificar código ao final da imagem
            const mudou = await verificarCodigoDispositivoAoCiclo();
            if (mudou) {
              return; // Se mudou, carregarConteudo já foi chamado
            }
            
            if (pendingResync) {
              pendingResync = false;
              await carregarConteudo(currentPlaylistId || codigoAtual);
            }
            proximoItem();
          }, duration);
        }
      });
    };
    img.onerror = () => {
      isPlaying = false;
      proximoItem();
    };

    img.src = itemUrl;
  }
}

// Funções de transição fade in/out
function fadeIn(el) {
  el.style.opacity = 0;
  el.style.display = "block";
  let o = 0;
  const it = setInterval(() => {
    o += 0.05;
    el.style.opacity = o;
    if (o >= 1) clearInterval(it);
  }, 50);
}

function fadeOut(el, cb) {
  let o = 1;
  const it = setInterval(() => {
    o -= 0.05;
    el.style.opacity = o;
    if (o <= 0) {
      clearInterval(it);
      el.style.display = "none";
      if (cb) cb();
    }
  }, 50);
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
      console.log("🐌 Internet lenta detectada:", duration.toFixed(0), "ms");
    } else if (duration < 500) {
      networkSpeed = 'fast';
      console.log("⚡ Internet rápida detectada:", duration.toFixed(0), "ms");
    } else {
      networkSpeed = 'normal';
    }
    
    return networkSpeed;
  } catch (err) {
    networkSpeed = 'slow';
    console.log("🐌 Assumindo internet lenta devido a erro:", err.message);
    return 'slow';
  }
}

function getAdaptiveTimeout(baseTimeout) {
  if (networkSpeed === 'slow') {
    return baseTimeout * 3; // 3x mais tempo para internet lenta
  } else if (networkSpeed === 'fast') {
    return baseTimeout * 0.7; // 30% menos tempo para internet rápida
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

// ===== Verificar código do dispositivo ao final de ciclo =====
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
      // Se tabela não existir, ignorar
      if (error.message && error.message.includes('relation') && error.message.includes('does not exist')) {
        return false;
      }
      return false;
    }
    
    if (dispositivo && dispositivo.codigo_display && dispositivo.codigo_display !== codigoAtual) {
      console.log("🔄 Código mudou ao final do ciclo:", codigoAtual, "→", dispositivo.codigo_display);
      
      const novoCodigo = dispositivo.codigo_display;
      const codigoAntigo = codigoAtual;
      
            // Desbloquear display antigo
            if (codigoAntigo && codigoAntigo !== novoCodigo) {
              try {
                await client
                  .from("displays")
                  .update({ is_locked: false, status: "Disponível" })
                  .eq("codigo_unico", codigoAntigo);
              } catch (err) {
                console.warn("⚠️ Erro ao desbloquear display antigo:", err);
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
        console.warn("⚠️ Erro ao bloquear novo display:", err);
      }
      
      // Atualizar localStorage
      localStorage.setItem(CODIGO_DISPLAY_KEY, novoCodigo);
      if (dispositivo.local_nome) {
        localStorage.setItem(LOCAL_TELA_KEY, dispositivo.local_nome);
      }
      
      // Atualizar variável global
      codigoAtual = novoCodigo;
      
      // Limpar cache antigo
      await resetAllCachesForNewCode();
      
      // Recarregar conteúdo com novo código
      await carregarConteudo(novoCodigo);
      
      console.log("✅ Código alterado ao final do ciclo e conteúdo recarregado");
      return true; // Indica que mudou
    }
    
    return false; // Não mudou
  } catch (err) {
    console.warn("⚠️ Erro ao verificar código do dispositivo:", err);
    return false;
  }
}

function proximoItem() {
  // imagem única estática: não avança
  if (!currentPlaylistId && playlist.length === 1) {
    const only = playlist[0];
    const isImg = /\.(jpg|jpeg|png|webp)(\?|$)/i.test(only.url) || (only.tipo || "").toLowerCase() === "imagem";
    if (isImg && only.duration === 0) {
      // Verificar código mesmo em imagem estática
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
  
  // Ao fim de cada ciclo, verificar se código mudou na tabela dispositivos
  if (cicloCompleto && navigator.onLine) {
    console.log("🔄 Ciclo completo finalizado, verificando código do dispositivo...");
    
    verificarCodigoDispositivoAoCiclo().then((mudou) => {
      if (mudou) {
        // Se mudou, carregarConteudo já foi chamado, não precisa continuar
        return;
      }
      
      // Se não mudou, continuar com verificação de playlist
      if (currentPlaylistId) {
        console.log("🔄 Recarregando playlist do banco...");
        // Preservar o índice atual para continuar do mesmo ponto após recarregar
        const indiceParaContinuar = currentIndex; // que será 0 (início do próximo ciclo)
        
        // Recarregar conteúdo do banco para pegar mudanças na playlist
        carregarConteudo(currentPlaylistId).then(() => {
          console.log("✅ Playlist recarregada, cache será atualizado se houver mudanças");
          // Garantir que o índice esteja válido após recarregar
          if (playlist.length > 0) {
            currentIndex = Math.min(indiceParaContinuar, playlist.length - 1);
            // Se a playlist não mudou, continuar do início normalmente
            // Se mudou, atualizarPlaylist já ajustou o índice corretamente
            if (!isPlaying) {
              tocarLoop();
            }
          }
        }).catch(err => {
          console.error("❌ Erro ao recarregar playlist:", err);
          // Continuar mesmo se houver erro
          if (playlist.length > 0) {
            currentIndex = Math.min(indiceParaContinuar, playlist.length - 1);
            tocarLoop();
          }
        });
      } else {
        // Conteúdo único, apenas continuar
        tocarLoop();
      }
    });
    return; // Não chamar tocarLoop aqui, será chamado dentro do then
  }
  
  tocarLoop();
}

// ===== Realtime =====
function subscribePlaylistChannel(playlistId) {
  if (playlistChannel) {
    client.removeChannel(playlistChannel);
    playlistChannel = null;
  }
  if (!playlistId) return; // conteúdo único

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
    .subscribe();
}

function iniciarRealtime() {
  if (displaysChannel) client.removeChannel(displaysChannel);

  displaysChannel = client
    .channel("realtime:displays")
    .on(
      "postgres_changes",
      { event: "UPDATE", schema: "public", table: "displays" },
      async (payload) => {
        // Verificar mudanças de device_id (opcional - não quebra se campo não existir)
        try {
          const deviceId = gerarDeviceId();
          
          // Verificar se a mudança é para este dispositivo (via device_id)
          if (payload.new.device_id && payload.new.device_id === deviceId && payload.new.device_id !== payload.old?.device_id) {
            // Dispositivo foi atribuído a um novo código remotamente
            const novoCodigo = payload.new.codigo_unico;
            console.log("🔄 Código alterado remotamente para este dispositivo:", novoCodigo);
            
            // Atualizar código salvo
            localStorage.setItem(CODIGO_DISPLAY_KEY, novoCodigo);
            
            // Recarregar página para aplicar novo código
            location.reload();
            return;
          }
        } catch (err) {
          // Ignorar erros relacionados a device_id (campo pode não existir)
        }
        
        // Verificar mudanças no display atual
        if (payload.new.codigo_unico !== codigoAtual) return;

        // Verificar se é o mesmo dispositivo antes de recarregar
        try {
          const deviceId = gerarDeviceId();
          const mesmoDispositivo = payload.new.device_id && payload.new.device_id === deviceId;
          
          // Se is_locked = false, significa que exibição foi parada
          // Limpar tudo e não continuar
          if (payload.new.is_locked === false) {
            console.log("⏸️ Display desbloqueado via realtime (is_locked = false), parando exibição...");
            
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
        } catch (err) {
          // Se não conseguir verificar device_id, usar comportamento antigo
          if (payload.new.is_locked === false) {
            console.log("⏸️ Display desbloqueado (is_locked = false), parando exibição...");
            
            // Limpar localStorage
            localStorage.removeItem(CODIGO_DISPLAY_KEY);
            localStorage.removeItem(LOCAL_TELA_KEY);
            
            navigator.serviceWorker.controller?.postMessage({ action: "clearNamespace" });
            await pararTudoMostrarLogin();
            return;
          }
        }

        const novoCodigo = payload.new.codigo_conteudoAtual;
        if (novoCodigo && novoCodigo !== currentContentCode) {
          console.log("🔄 Conteúdo alterado remotamente:", novoCodigo);
          carregarConteudo(novoCodigo);
        }
      }
    )
    .subscribe();

  subscribePlaylistChannel(currentPlaylistId);
  
  // Realtime para tabela dispositivos (nova tabela)
  subscribeDispositivosChannel();
}

// ===== Realtime para dispositivos =====
function subscribeDispositivosChannel() {
  if (dispositivosChannel) {
    client.removeChannel(dispositivosChannel);
    dispositivosChannel = null;
  }
  
  const deviceId = gerarDeviceId();
  console.log("🔌 Conectando realtime para dispositivo:", deviceId);
  
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
          console.log("📡 Realtime recebido - dispositivos:", payload);
          // Se codigo_display mudou remotamente, atualizar
          if (payload.new.codigo_display && payload.new.codigo_display !== payload.old?.codigo_display) {
            const novoCodigo = payload.new.codigo_display;
            const codigoAntigo = codigoAtual;
            
            console.log("🔄 Código do display alterado remotamente:", codigoAntigo, "→", novoCodigo);
            
            // Desbloquear display antigo (se existir)
            if (codigoAntigo && codigoAntigo !== novoCodigo) {
              try {
                await client
                  .from("displays")
                  .update({ is_locked: false, status: "Disponível" })
                  .eq("codigo_unico", codigoAntigo);
              } catch (err) {
                console.warn("⚠️ Erro ao desbloquear display antigo:", err);
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
              console.warn("⚠️ Erro ao bloquear novo display:", err);
            }
            
            // Atualizar localStorage
            localStorage.setItem(CODIGO_DISPLAY_KEY, novoCodigo);
            if (payload.new.local_nome) {
              localStorage.setItem(LOCAL_TELA_KEY, payload.new.local_nome);
            }
            
            // Atualizar variável global
            codigoAtual = novoCodigo;
            
            // Limpar cache antigo
            await resetAllCachesForNewCode();
            
            // Recarregar conteúdo com novo código
            await carregarConteudo(novoCodigo);
            
            console.log("✅ Código alterado e conteúdo recarregado");
          }
          
          // Se local_nome mudou, atualizar
          if (payload.new.local_nome && payload.new.local_nome !== payload.old?.local_nome) {
            localStorage.setItem(LOCAL_TELA_KEY, payload.new.local_nome);
            console.log("🔄 Local da tela alterado:", payload.new.local_nome);
          }
        }
      )
      .subscribe((status) => {
        if (status === 'SUBSCRIBED') {
          console.log("✅ Realtime conectado - dispositivos (SUBSCRIBED)");
        } else if (status === 'CHANNEL_ERROR') {
          console.error("❌ Erro no channel de dispositivos:", status);
        } else {
          console.log("📡 Status do channel de dispositivos:", status);
        }
      });
      
    console.log("🔌 Channel de dispositivos criado");
  } catch (err) {
    // Se tabela não existir, ignorar (retrocompatibilidade)
    if (err.message && err.message.includes('relation') && err.message.includes('does not exist')) {
      console.log("ℹ️ Tabela dispositivos ainda não criada (opcional)");
    } else {
      console.error("❌ Erro ao criar channel de dispositivos:", err);
    }
  }
  
  // FALLBACK: Verificação periódica caso realtime não funcione
  if (dispositivosCheckTimer) clearInterval(dispositivosCheckTimer);
  dispositivosCheckTimer = setInterval(async () => {
    await verificarMudancaDispositivo();
  }, 5000); // Verificar a cada 5 segundos
}

// ===== Verificação periódica de mudanças (fallback) =====
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
      // Se tabela não existir, ignorar
      if (error.message && error.message.includes('relation') && error.message.includes('does not exist')) {
        return;
      }
      console.warn("⚠️ Erro ao verificar dispositivo:", error);
      return;
    }
    
    if (dispositivo && dispositivo.codigo_display && dispositivo.codigo_display !== codigoAtual) {
      console.log("🔄 Mudança detectada via polling:", codigoAtual, "→", dispositivo.codigo_display);
      
      // Mesma lógica do realtime
      const novoCodigo = dispositivo.codigo_display;
      const codigoAntigo = codigoAtual;
      
            // Desbloquear display antigo
            if (codigoAntigo && codigoAntigo !== novoCodigo) {
              try {
                await client
                  .from("displays")
                  .update({ is_locked: false, status: "Disponível" })
                  .eq("codigo_unico", codigoAntigo);
              } catch (err) {
                console.warn("⚠️ Erro ao desbloquear display antigo:", err);
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
        console.warn("⚠️ Erro ao bloquear novo display:", err);
      }
      
      // Atualizar localStorage
      localStorage.setItem(CODIGO_DISPLAY_KEY, novoCodigo);
      if (dispositivo.local_nome) {
        localStorage.setItem(LOCAL_TELA_KEY, dispositivo.local_nome);
      }
      
      // Atualizar variável global
      codigoAtual = novoCodigo;
      
      // Limpar cache antigo
      await resetAllCachesForNewCode();
      
      // Recarregar conteúdo com novo código
      await carregarConteudo(novoCodigo);
      
      console.log("✅ Código alterado via polling e conteúdo recarregado");
    }
  } catch (err) {
    console.warn("⚠️ Erro na verificação periódica de dispositivo:", err);
  }
}

// ===== Cleanup/lock =====
async function pararTudoMostrarLogin() {
  // Parar e esconder vídeo
  if (video) {
    try { 
      video.pause(); 
      video.currentTime = 0;
      video.removeAttribute("src");
      video.load();
    } catch {}
    video.style.display = "none";
  }
  
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
  
  // Limpar variáveis
  codigoAtual = null;
  currentPlaylistId = null;
  playlist = [];
  currentIndex = 0;
  currentItemUrl = null;
  isPlaying = false;
  
  // Limpar promoção
  fecharPopupPromocao();
  
  // Mostrar tela de login (já faz tudo necessário)
  mostrarLogin();
  
  // Limpar campos (não restaurar código salvo se is_locked = false)
  const codigoField = document.getElementById("codigoTela");
  const localField = document.getElementById("localTela");
  if (codigoField) {
    codigoField.value = "";
    codigoField.focus();
  }
  if (localField) {
    localField.value = "";
  }
}

// ===== Função para entrar em fullscreen =====
function entrarFullscreen() {
  const elem = document.documentElement;
  
  // Verificar se já está em fullscreen
  if (document.fullscreenElement || document.webkitFullscreenElement || document.mozFullScreenElement || document.msFullscreenElement) {
    return; // Já está em fullscreen
  }
  
  // Tentar entrar em fullscreen com várias estratégias
  const tryFullscreen = () => {
    if (elem.requestFullscreen) {
      return elem.requestFullscreen().catch(err => {
        console.log("⚠️ requestFullscreen falhou:", err.message);
        return false;
      });
    } else if (elem.webkitRequestFullscreen) {
      elem.webkitRequestFullscreen();
      return Promise.resolve(true);
    } else if (elem.mozRequestFullScreen) {
      elem.mozRequestFullScreen();
      return Promise.resolve(true);
    } else if (elem.msRequestFullscreen) {
      elem.msRequestFullscreen();
      return Promise.resolve(true);
    }
    return Promise.resolve(false);
  };
  
  // Tentar imediatamente
  tryFullscreen().then(success => {
    if (!success) {
      // Se falhar, tentar novamente após um pequeno delay
      setTimeout(() => tryFullscreen(), 200);
    }
  });
  
  // Para Android Chrome, também tentar com o body
  if (/Android/i.test(navigator.userAgent)) {
    setTimeout(() => {
      const body = document.body;
      if (body.requestFullscreen) {
        body.requestFullscreen().catch(() => {});
      } else if (body.webkitRequestFullscreen) {
        body.webkitRequestFullscreen();
      }
    }, 100);
  }
}

function mostrarLogin() {
  // Sair do fullscreen se estiver em fullscreen
  if (document.fullscreenElement || document.webkitFullscreenElement) {
    if (document.exitFullscreen) {
      document.exitFullscreen().catch(() => {});
    } else if (document.webkitExitFullscreen) {
      document.webkitExitFullscreen();
    }
  }
  
  // Garantir que vídeo e imagem estejam escondidos e com z-index baixo
  const video = document.getElementById("videoPlayer");
  const img = document.getElementById("imgPlayer");
  if (video) {
    video.style.display = "none";
    video.style.zIndex = "-1";
    video.style.opacity = "0";
    try { video.pause(); } catch {}
  }
  if (img) {
    img.style.display = "none";
    img.style.zIndex = "-1";
    img.style.opacity = "0";
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
    
    // Garantir que o body tenha background visível
    document.body.style.backgroundColor = "#000";
    document.body.style.overflow = "auto"; // Permitir scroll se necessário
  }, 100);
}

async function checarLockEConteudo() {
  if (!codigoAtual || !navigator.onLine) return;
  try {
    const deviceId = gerarDeviceId();
    
    // Buscar com device_id para verificar se é o mesmo dispositivo
    let { data, error } = await client
      .from("displays")
      .select("is_locked,codigo_conteudoAtual,device_id")
      .eq("codigo_unico", codigoAtual)
      .maybeSingle();
    
    // Se não encontrou device_id, tentar sem ele (retrocompatibilidade)
    if (error && error.message && error.message.includes('column') && error.message.includes('does not exist')) {
      const { data: dataBasica } = await client
        .from("displays")
        .select("is_locked,codigo_conteudoAtual")
        .eq("codigo_unico", codigoAtual)
        .maybeSingle();
      data = dataBasica;
    }

    if (!data) return;

    // Verificar se é o mesmo dispositivo
    const mesmoDispositivo = data.device_id && data.device_id === deviceId;
    
    // Se is_locked = false, significa que exibição foi parada
    // Limpar tudo e não continuar (independente de ser o mesmo dispositivo)
    if (data.is_locked === false) {
      console.log("⏸️ Display desbloqueado na verificação periódica (is_locked = false), parando exibição...");
      
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

    if (data.codigo_conteudoAtual && data.codigo_conteudoAtual !== currentContentCode) {
      await carregarConteudo(data.codigo_conteudoAtual);
    }

    // Verificar promoção continuamente
    await verificarPromocaoContinuamente();
  } catch {}
}

// ===== Service Worker =====
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('service-worker.js')
    .then(async (registration) => {
      console.log('✅ Service Worker registrado:', registration.scope);
      await navigator.serviceWorker.ready;
      console.log('✅ Service Worker pronto para uso');
      
      navigator.serviceWorker.addEventListener('message', event => {
        if (event.data.action === "checkItem") {
          const isValid = playlist.some(item =>
            item.url === event.data.url ||
            item.urlPortrait === event.data.url ||
            item.urlLandscape === event.data.url
          );
          event.ports[0].postMessage({ valid: isValid });
        } else if (event.data.action === "cacheUpdated") {
          console.log("📦 Cache atualizado pelo Service Worker");
          // Atualizar status do cache no banco
          if (codigoAtual) {
            atualizarStatusCache(codigoAtual, true);
          }
        }
      });
    })
    .catch((error) => {
      console.error('❌ Erro ao registrar Service Worker:', error);
    });
} else {
  console.warn('⚠️ Service Worker não suportado neste navegador');
}

// ===== UI Events / Heartbeat / Unlock =====

// Debounce do evento online
window.addEventListener("online", () => {
  if (onlineDebounceId) clearTimeout(onlineDebounceId);
  onlineDebounceId = setTimeout(async () => {
    if (codigoAtual) {
      try {
        const deviceId = gerarDeviceId();
        
        // Buscar com device_id para verificar se é o mesmo dispositivo
        let { data, error } = await client
          .from("displays")
          .select("is_locked,device_id")
          .eq("codigo_unico", codigoAtual)
          .maybeSingle();
        
        // Se não encontrou device_id, tentar sem ele (retrocompatibilidade)
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
          
          // Se is_locked = false, significa que exibição foi parada - limpar tudo
          if (data.is_locked === false) {
            console.log("⏸️ Display desbloqueado ao voltar online (is_locked = false), parando exibição...");
            
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
          
          // Se está locked e é o mesmo dispositivo, garantir lock
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
              // Se campos não existirem, fazer update sem eles
              if (updateErr.message && updateErr.message.includes('column') && updateErr.message.includes('does not exist')) {
                await client
                  .from("displays")
                  .update({ is_locked: true, status: "Em uso" })
                  .eq("codigo_unico", codigoAtual);
              }
            }
          }
        }
      } catch {}
    }

    if (!realtimeReady) {
      iniciarRealtime();
      realtimeReady = true;
    }

    if (isPlaying) {
      pendingResync = true;
    } else if (codigoAtual) {
      await carregarConteudo(currentPlaylistId || codigoAtual);
    }
  }, 1200);
});

setInterval(async () => {
  if (codigoAtual && navigator.onLine) {
    try {
      // Atualização básica (sempre funciona)
      const updateData = { 
        status_tela: "Online", 
        last_ping: new Date().toISOString()
      };
      
      // Tentar adicionar campos de dispositivo (opcional)
      try {
        const deviceId = gerarDeviceId();
        updateData.device_id = deviceId;
        updateData.device_last_seen = new Date().toISOString();
      } catch {
        // Ignorar se device_id não puder ser gerado
      }
      
      await client
        .from("displays")
        .update(updateData)
        .eq("codigo_unico", codigoAtual);
    } catch (err) {
      // Se erro for de coluna não encontrada, fazer update sem campos opcionais
      if (err.message && err.message.includes('column') && err.message.includes('does not exist')) {
        try {
          await client
            .from("displays")
            .update({ 
              status_tela: "Online", 
              last_ping: new Date().toISOString()
            })
            .eq("codigo_unico", codigoAtual);
        } catch {}
      }
    }
  }
}, 5 * 60 * 1000);

window.addEventListener("beforeunload", () => {
  if (!codigoAtual) return;

  // limpa cache do namespace desta tela
  navigator.serviceWorker.controller?.postMessage({ action: "clearNamespace" });

  const url = `${supabaseUrl}/rest/v1/displays?codigo_unico=eq.${encodeURIComponent(codigoAtual)}&apikey=${encodeURIComponent(supabaseKey)}`;
  const payload = JSON.stringify({ is_locked: false, status: "Disponível" });
  const blob = new Blob([payload], { type: "application/json" });
  navigator.sendBeacon(url, blob);
  
  // Desativar dispositivo na tabela dispositivos
  try {
    const deviceId = gerarDeviceId();
    const urlDispositivos = `${supabaseUrl}/rest/v1/dispositivos?device_id=eq.${encodeURIComponent(deviceId)}&apikey=${encodeURIComponent(supabaseKey)}`;
    const payloadDispositivos = JSON.stringify({ is_ativo: false });
    const blobDispositivos = new Blob([payloadDispositivos], { type: "application/json" });
    navigator.sendBeacon(urlDispositivos, blobDispositivos);
  } catch (err) {
    // Ignorar erros no beforeunload
  }
  
  // Limpar localStorage quando fechar (já que is_locked = false)
  localStorage.removeItem(CODIGO_DISPLAY_KEY);
  localStorage.removeItem(LOCAL_TELA_KEY);
});

// ===== Debug Helper =====
function debugVideoState() {
  console.log('🔍 Estado atual do vídeo:', {
    isLoadingVideo,
    currentVideoToken,
    isPlaying,
    videoSrc: video.src,
    videoReadyState: video.readyState,
    videoNetworkState: video.networkState,
    videoPaused: video.paused
  });
}

// ===== Funções de Promoção =====
async function verificarPromocao() {
  if (!codigoAtual) return;
  
  try {
    console.log("🔍 Verificando promoção para código:", codigoAtual);
    
    const { data: display, error: displayError } = await client
      .from("displays")
      .select("promo, id_promo")
      .eq("codigo_unico", codigoAtual)
      .single();

    if (displayError) {
      console.error("Erro ao buscar display:", displayError);
      return;
    }

    console.log("📊 Dados do display:", display);

    if (!display || !display.promo || !display.id_promo) {
      console.log("❌ Nenhuma promoção ativa para esta tela");
      return;
    }

    console.log("🔍 Buscando promoção com id_promo:", display.id_promo);

    const { data: promocao, error: promoError } = await client
      .from("promo")
      .select("*")
      .eq("id_promo", display.id_promo)
      .single();

    if (promoError) {
      console.error("Erro ao buscar promoção:", promoError);
      return;
    }

    console.log("🎯 Dados da promoção:", promocao);

    if (!promocao) {
      console.log("❌ Promoção não encontrada");
      return;
    }

    promoData = promocao;
    promoCounter = promocao.contador || 0;
    
    console.log("⏰ Contador da promoção:", promoCounter);
    
    if (promoCounter <= 0) {
      console.log("⏰ Contador zerado, desativando promoção");
      await desativarPromocao();
      return;
    }

    console.log("✅ Exibindo popup de promoção");
    mostrarPopupPromocao();
  } catch (err) {
    console.error("Erro ao verificar promoção:", err);
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
  lightningIcon.innerHTML = '⚡';
  lightningIcon.style.cssText = `
    font-size: 32px;
    color: #FCD34D;
    text-shadow: 0 0 10px rgba(252, 211, 77, 0.5);
    animation: pulse 2s infinite;
  `;

  const headerText = document.createElement('div');
  headerText.textContent = 'OFERTA RELÂMPAGO';
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

  // Conteúdo principal
  const content = document.createElement('div');
  content.style.cssText = `
    padding: 30px;
    text-align: center;
  `;

  // Imagem da promoção (dentro da área branca do popup)
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

  // Texto da promoção
  const promoText = document.createElement('div');
  promoText.id = 'promoText';
  promoText.textContent = promoData.texto_promo || 'Promoção especial';
  promoText.style.cssText = `
    font-size: 24px;
    color: #374151;
    margin-bottom: 25px;
    font-weight: 700;
    line-height: 1.3;
    text-align: center;
    animation: textGlow 3s ease-in-out infinite alternate;
  `;

  // Preço original (riscado)
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

  // Preço promocional
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
  ultimasUnidades.textContent = 'ÚLTIMAS UNIDADES';
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

  // Montar o modal (imagem dentro da área branca, entre header e texto)
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

  // Adicionar animação CSS
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

// Função para verificar promoção continuamente (sem causar piscar)
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

    // Se não há promoção ativa e popup está aberto, fechar
    if (!display || !display.promo || !display.id_promo) {
      if (promoPopup) {
        console.log("🔄 Promoção desativada, fechando popup");
        fecharPopupPromocao();
      }
      return;
    }

    // Se há promoção ativa e popup não está aberto, abrir
    if (!promoPopup) {
      console.log("🔄 Promoção ativada, abrindo popup");
      await verificarPromocao();
    } else {
      // Se popup está aberto, verificar se contador mudou no banco
      await verificarContadorNoBanco(display.id_promo);
    }
  } catch (err) {
    console.error("Erro ao verificar promoção continuamente:", err);
  }
}

// Função para verificar mudanças no contador no banco
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
        console.log(`🔄 Contador mudou no banco: ${promoCounter} → ${promocao.contador}`);
        atualizarContadorPromocao(promocao.contador);
      }
      
      // Verificar se dados da promo mudaram e atualizar
      atualizarDadosPromocao(promocao);
    }
  } catch (err) {
    console.error("Erro ao verificar contador no banco:", err);
  }
}

// Função para formatar valores monetários
function formatarValorMonetario(valor) {
  if (!valor) return '0,00';
  
  // Se o valor já tem vírgula, usar como está
  if (valor.toString().includes(',')) {
    return valor.toString();
  }
  
  const numero = parseFloat(valor);
  
  // Se o valor é muito grande (provavelmente em centavos), dividir por 100
  if (numero >= 100 && Number.isInteger(numero)) {
    const valorEmReais = numero / 100;
    return valorEmReais.toLocaleString('pt-BR', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2
    });
  }
  
  // Se o valor é menor que 100, tratar como reais
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

// Função para atualizar contador dinamicamente
function atualizarContadorPromocao(novoValor) {
  promoCounter = novoValor;
  
  const counterElement = document.getElementById('promoCounter');
  if (counterElement) {
    counterElement.textContent = promoCounter;
  }
  
  // Se contador chegar a zero, desativar promoção
  if (promoCounter <= 0) {
    desativarPromocao();
  }
}

// Função para atualizar dados da promoção em tempo real
function atualizarDadosPromocao(promocao) {
  // Atualizar texto da promoção
  const promoTextElement = document.getElementById('promoText');
  if (promoTextElement && promocao.texto_promo) {
    promoTextElement.textContent = promocao.texto_promo;
  }
  
  // Atualizar preço original
  const originalPriceElement = document.getElementById('promoOriginalPrice');
  if (originalPriceElement && promocao.valor_antes) {
    originalPriceElement.textContent = `R$ ${formatarValorMonetario(promocao.valor_antes)}`;
  }
  
  // Atualizar preço promocional
  const promoPriceElement = document.getElementById('promoPrice');
  if (promoPriceElement && promocao.valor_promo) {
    promoPriceElement.textContent = `R$ ${formatarValorMonetario(promocao.valor_promo)}`;
  }
}

async function desativarPromocao() {
  try {
    console.log("🔄 Desativando promoção...");
    
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
        console.error("Erro ao deletar promoção:", deleteError);
      }
    }

    console.log("✅ Promoção desativada com sucesso");
    fecharPopupPromocao();
  } catch (err) {
    console.error("Erro ao desativar promoção:", err);
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
  // Funções para gerenciar código salvo
  getCodigoSalvo() {
    const codigo = localStorage.getItem(CODIGO_DISPLAY_KEY);
    console.log("[mritDebug] Código salvo:", codigo || "nenhum");
    return codigo;
  },
  limparCodigoSalvo() {
    limparCodigoSalvo();
    console.log("[mritDebug] Código salvo removido");
  },
  salvarCodigo(codigo) {
    if (!codigo || !codigo.trim()) {
      console.log("[mritDebug] Código inválido");
      return;
    }
    localStorage.setItem(CODIGO_DISPLAY_KEY, codigo.trim().toUpperCase());
    console.log("[mritDebug] Código salvo:", codigo.trim().toUpperCase());
  },
  verificarCodigoSalvo() {
    verificarCodigoSalvo();
    console.log("[mritDebug] Verificação de código salvo executada");
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
          // Se erro for de coluna não encontrada, informar
          if (error.message && error.message.includes('column') && error.message.includes('does not exist')) {
            console.log("[mritDebug] Campos de dispositivo ainda não criados no banco");
            return null;
          }
          console.error("[mritDebug] Erro:", error);
          return null;
        }
        
        console.log("[mritDebug] Displays vinculados a este dispositivo:", data);
        return data;
      } catch (selectErr) {
        if (selectErr.message && selectErr.message.includes('column') && selectErr.message.includes('does not exist')) {
          console.log("[mritDebug] Campos de dispositivo ainda não criados no banco");
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
      console.log("❌ URL não fornecida");
      return;
    }
    const cacheKey = `${codigoAtual}::${url}`;
    try {
      const blob = await idbGet(cacheKey);
      if (blob) {
        console.log("✅ Vídeo encontrado no cache:", url, "Tamanho:", blob.size, "bytes");
        return true;
      } else {
        console.log("❌ Vídeo NÃO encontrado no cache:", url);
        return false;
      }
    } catch (error) {
      console.error("Erro ao verificar cache:", error);
      return false;
    }
  },
  async checkCacheImagem(url) {
    if (!url) {
      console.log("❌ URL não fornecida");
      return;
    }
    try {
      const cache = await caches.open("mrit-player-cache-v12");
      const cachedResponse = await cache.match(url);
      if (cachedResponse && cachedResponse.ok) {
        console.log("✅ Imagem encontrada no cache:", url);
        return true;
      } else {
        console.log("❌ Imagem NÃO encontrada no cache:", url);
        return false;
      }
    } catch (error) {
      console.error("Erro ao verificar cache da imagem:", error);
      return false;
    }
  },
  async checkAllCache() {
    console.log("🔍 Verificando cache para todos os itens da playlist...");
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
  // Funções de controle da promoção
  atualizarContador(valor) {
    atualizarContadorPromocao(valor);
    console.log(`[mritDebug] Contador atualizado para: ${valor}`);
  },
  fecharPromocao() {
    fecharPopupPromocao();
    console.log("[mritDebug] Popup de promoção fechado");
  },
  verificarPromocao() {
    verificarPromocao();
    console.log("[mritDebug] Verificação de promoção executada");
  },
  verificarContador() {
    if (promoData && promoData.id_promo) {
      verificarContadorNoBanco(promoData.id_promo);
      console.log("[mritDebug] Verificação de contador executada");
    } else {
      console.log("[mritDebug] Nenhuma promoção ativa para verificar contador");
    }
  },
  forcarVerificacao() {
    verificarPromocaoContinuamente();
    console.log("[mritDebug] Verificação forçada executada");
  },
  async forcarCache() {
    if (navigator.serviceWorker.controller) {
      navigator.serviceWorker.controller.postMessage({
        action: "forceCache",
        playlist: playlist
      });
      console.log("[mritDebug] Forçando cache da playlist atual via Service Worker");
    } else {
      console.log("[mritDebug] Service Worker não disponível, usando cache direto");
      await this.forcarCacheDireto();
    }
  },
  async forcarCacheDireto() {
    console.log("🔄 Forçando cache direto no IndexedDB...");
    
    if (!playlist || playlist.length === 0) {
      console.log("❌ Nenhuma playlist carregada");
      return;
    }
    
    let cachedCount = 0;
    let failedCount = 0;
    const maxVideos = 12;
    const maxSize = 1024 * 1024 * 1024; // 1GB
    const maxRetries = 5;
    
    for (const item of playlist) {
      if (cachedCount >= maxVideos) {
        console.log("⚠️ Limite de vídeos atingido");
        break;
      }
      
      const url = pickSourceForOrientation(item);
      const isVideo = /\.(mp4|webm|mkv|mov|avi)(\?|$)/i.test(url);
      
      if (!isVideo) {
        console.log("⏭️ Pulando item não-vídeo:", url);
        continue;
      }
      
      let success = false;
      let retryCount = 0;
      
      while (!success && retryCount <= maxRetries) {
        try {
          // Verificar se já está em cache
          const cacheKey = `${codigoAtual}::${url}`;
          const existingBlob = await idbGet(cacheKey);
          
          if (existingBlob && existingBlob.size > 0) {
            console.log("✅ Já em cache:", url, "Tamanho:", existingBlob.size, "bytes");
            success = true;
            cachedCount++;
            break;
          }
          
          if (retryCount > 0) {
            console.log(`🔄 Tentativa ${retryCount + 1} de ${maxRetries + 1} para baixar:`, url);
            // Aguardar um pouco antes de tentar novamente
            await new Promise(resolve => setTimeout(resolve, 2000 * retryCount));
          } else {
            console.log("📥 Baixando vídeo:", url);
          }
          
          // Baixar vídeo com timeout maior
          const controller = new AbortController();
          const timeoutId = setTimeout(() => controller.abort(), 60000); // 60 segundos
          
          const response = await fetch(url, { 
            method: 'GET',
            cache: 'no-store',
            signal: controller.signal
          });
          
          clearTimeout(timeoutId);
          
          if (!response.ok) {
            console.log("❌ Falha ao baixar:", url, "Status:", response.status);
            retryCount++;
            continue;
          }
          
          const blob = await response.blob();
          
          if (!blob || blob.size === 0) {
            console.log("❌ Blob vazio:", url);
            retryCount++;
            continue;
          }
          
          if (blob.size > maxSize) {
            console.log("⚠️ Arquivo muito grande:", url, "Tamanho:", blob.size, "bytes");
            retryCount++;
            continue;
          }
          
          // Salvar no IndexedDB
          await idbSet(cacheKey, blob);
          cachedCount++;
          success = true;
          
          console.log("✅ Vídeo em cache:", url, "Tamanho:", blob.size, "bytes", "MB:", (blob.size / 1024 / 1024).toFixed(2));
          
        } catch (error) {
          retryCount++;
          if (retryCount > maxRetries) {
            console.error("❌ Erro ao baixar vídeo após", maxRetries + 1, "tentativas:", url, error.message);
            failedCount++;
          } else {
            console.warn("⚠️ Erro na tentativa", retryCount, "para", url, ":", error.message);
          }
        }
      }
    }
    
    console.log(`🎉 Cache concluído: ${cachedCount} vídeos armazenados, ${failedCount} falharam`);
    
    // Atualizar status do cache no banco
    if (cachedCount > 0) {
      await atualizarStatusCache(codigoAtual, true);
    }
    
    return { cachedCount, failedCount };
  },
  async forcarCacheImagens() {
    console.log("🔄 Forçando cache de imagens...");
    
    if (!playlist || playlist.length === 0) {
      console.log("❌ Nenhuma playlist carregada");
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
          // Verificar se já está em cache
          const cache = await caches.open("mrit-player-cache-v12");
          const cachedResponse = await cache.match(url);
          
          if (cachedResponse && cachedResponse.ok) {
            console.log("✅ Imagem já em cache:", url);
            success = true;
            cachedCount++;
            break;
          }
          
          if (retryCount > 0) {
            console.log(`🔄 Tentativa ${retryCount + 1} de ${maxRetries + 1} para baixar imagem:`, url);
            await new Promise(resolve => setTimeout(resolve, 1000 * retryCount));
          } else {
            console.log("📥 Baixando imagem:", url);
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
            console.log("❌ Falha ao baixar imagem:", url, "Status:", response.status);
            retryCount++;
            continue;
          }
          
          // Salvar no cache
          await cache.put(url, response.clone());
          cachedCount++;
          success = true;
          
          console.log("✅ Imagem em cache:", url);
          
        } catch (error) {
          retryCount++;
          if (retryCount > maxRetries) {
            console.error("❌ Erro ao baixar imagem após", maxRetries + 1, "tentativas:", url, error.message);
            failedCount++;
          } else {
            console.warn("⚠️ Erro na tentativa", retryCount, "para imagem", url, ":", error.message);
          }
        }
      }
    }
    
    console.log(`🎉 Cache de imagens concluído: ${cachedCount} imagens armazenadas, ${failedCount} falharam`);
    
    return { cachedCount, failedCount };
  },
  async verificarCacheSW(url) {
    return new Promise((resolve) => {
      if (!navigator.serviceWorker.controller) {
        console.log("[mritDebug] Service Worker não disponível");
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
    console.log("🔍 Verificando caches via Service Worker...");
    for (const item of playlist) {
      const url = pickSourceForOrientation(item);
      const result = await this.verificarCacheSW(url);
      if (result) {
        console.log(`${result.cached ? '✅' : '❌'} ${url} - ${result.cached ? result.size + ' bytes' : 'não em cache'}`);
      }
    }
  },
  async verificarStatusCacheBanco() {
    if (!codigoAtual) {
      console.log("❌ Nenhum código de tela ativo");
      return;
    }
    
    try {
      const { data, error } = await client
        .from("displays")
        .select("codigo_unico, cache")
        .eq("codigo_unico", codigoAtual)
        .single();
      
      if (error) {
        console.error("❌ Erro ao buscar status do cache:", error);
        return;
      }
      
      if (data) {
        console.log(`📊 Status do cache no banco: ${data.cache ? '✅ Pronto' : '❌ Não pronto'}`);
        return data.cache;
      } else {
        console.log("❌ Tela não encontrada no banco");
        return false;
      }
    } catch (err) {
      console.error("❌ Erro na conexão:", err);
      return false;
    }
  },
  async forcarStatusCache(status = true) {
    if (!codigoAtual) {
      console.log("❌ Nenhum código de tela ativo");
      return;
    }
    
    await atualizarStatusCache(codigoAtual, status);
    console.log(`🔄 Status do cache forçado para: ${status ? 'pronto' : 'não pronto'}`);
  },
  async verificarCacheCompleto() {
    console.log("🔍 Verificação completa do cache...");
    const resultado = await verificarEAtualizarStatusCache();
    console.log(`📊 Resultado: ${resultado ? '✅ Cache pronto' : '❌ Cache não pronto'}`);
    return resultado;
  },
  async diagnosticoCompleto() {
    console.log("🔍 === DIAGNÓSTICO COMPLETO DO CACHE ===");
    
    // 1. Verificar Service Worker
    console.log("\n1️⃣ Verificando Service Worker...");
    const swAtivo = await this.verificarSW();
    
    // 2. Verificar playlist
    console.log("\n2️⃣ Verificando playlist...");
    console.log("📊 Playlist carregada:", playlist ? playlist.length : 0, "itens");
    if (playlist && playlist.length > 0) {
      const videos = playlist.filter(item => {
        const url = pickSourceForOrientation(item);
        return /\.(mp4|webm|mkv|mov|avi)(\?|$)/i.test(url);
      });
      const imagens = playlist.filter(item => {
        const url = pickSourceForOrientation(item);
        return /\.(jpg|jpeg|png|webp)(\?|$)/i.test(url);
      });
      console.log("📊 Vídeos na playlist:", videos.length);
      console.log("📊 Imagens na playlist:", imagens.length);
    }
    
    // 3. Verificar cache individual
    console.log("\n3️⃣ Verificando cache individual...");
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
    console.log("\n4️⃣ Verificando status no banco...");
    await this.verificarStatusCacheBanco();
    
    // 5. Verificar cache geral
    console.log("\n5️⃣ Verificando cache geral...");
    await this.verificarCacheCompleto();
    
    console.log("\n✅ Diagnóstico concluído!");
  },
  async limparCacheEStatus() {
    console.log("🧹 Limpando cache e status...");
    
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
    
    // Marcar como não pronto
    await atualizarStatusCache(codigoAtual, false);
    
    console.log("✅ Cache e status limpos");
  },
  async forcarCacheAutomatico() {
    console.log("🔄 Forçando cache automático...");
    
    // Verificar se Service Worker está disponível
    if (navigator.serviceWorker.controller) {
      console.log("📤 Usando Service Worker para cache...");
      await this.forcarCache();
    } else {
      console.log("📥 Usando cache direto...");
      await this.forcarCacheDireto();
    }
    
    // Aguardar um pouco e verificar
    setTimeout(async () => {
      await this.verificarCacheCompleto();
    }, 2000);
  },
  async forcarCacheCompleto() {
    console.log("🔄 Forçando cache completo (vídeos + imagens)...");
    
    const resultadoVideos = await this.forcarCacheDireto();
    const resultadoImagens = await this.forcarCacheImagens();
    
    console.log(`🎉 Cache completo concluído:`);
    console.log(`📹 Vídeos: ${resultadoVideos.cachedCount} cacheados, ${resultadoVideos.failedCount} falharam`);
    console.log(`🖼️ Imagens: ${resultadoImagens.cachedCount} cacheadas, ${resultadoImagens.failedCount} falharam`);
    
    // Verificar status final
    await this.verificarCacheCompleto();
    
    return { videos: resultadoVideos, imagens: resultadoImagens };
  },
  async verificarSW() {
    console.log("🔍 Verificando Service Worker...");
    
    if (!('serviceWorker' in navigator)) {
      console.log("❌ Service Worker não suportado neste navegador");
      return false;
    }
    
    try {
      const registration = await navigator.serviceWorker.getRegistration();
      if (!registration) {
        console.log("❌ Service Worker não registrado");
        return false;
      }
      
      console.log("✅ Service Worker registrado:", registration.scope);
      
      if (!navigator.serviceWorker.controller) {
        console.log("⚠️ Service Worker registrado mas não está controlando a página");
        console.log("💡 Tente recarregar a página ou aguardar alguns segundos");
        return false;
      }
      
      console.log("✅ Service Worker ativo e controlando a página");
      return true;
    } catch (error) {
      console.error("❌ Erro ao verificar Service Worker:", error);
      return false;
    }
  },
  async registrarSW() {
    console.log("🔄 Tentando registrar Service Worker...");
    
    if (!('serviceWorker' in navigator)) {
      console.log("❌ Service Worker não suportado neste navegador");
      return false;
    }
    
    try {
      const registration = await navigator.serviceWorker.register('service-worker.js');
      console.log("✅ Service Worker registrado com sucesso:", registration.scope);
      
      // Aguardar o SW estar pronto
      await navigator.serviceWorker.ready;
      console.log("✅ Service Worker pronto para uso");
      
      return true;
    } catch (error) {
      console.error("❌ Erro ao registrar Service Worker:", error);
      return false;
    }
  },
  async reiniciarSW() {
    console.log("🔄 Reiniciando Service Worker...");
    
    try {
      // Desregistrar SW atual
      const registrations = await navigator.serviceWorker.getRegistrations();
      for (const registration of registrations) {
        await registration.unregister();
        console.log("🗑️ Service Worker desregistrado:", registration.scope);
      }
      
      // Aguardar um pouco
      await new Promise(resolve => setTimeout(resolve, 1000));
      
      // Registrar novamente
      const success = await this.registrarSW();
      if (success) {
        console.log("✅ Service Worker reiniciado com sucesso");
        // Recarregar a página para ativar o novo SW
        console.log("🔄 Recarregando página em 2 segundos...");
        setTimeout(() => location.reload(), 2000);
      }
      
      return success;
    } catch (error) {
      console.error("❌ Erro ao reiniciar Service Worker:", error);
      return false;
    }
  }
};
