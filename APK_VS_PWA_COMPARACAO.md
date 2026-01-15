# 📱 APK (Capacitor) vs PWA - Comparação

## 🔍 Principais Diferenças

### APK (Capacitor) - O que você tem agora

| Característica | APK (Capacitor) |
|---------------|-----------------|
| **Instalação** | APK nativo (como app normal) |
| **Acesso ao sistema** | ✅ Controle total (fullscreen, wake lock, etc) |
| **Fullscreen** | ✅ Sempre ativo (MainActivity.java) |
| **Tela ligada** | ✅ Sempre ligada (FLAG_KEEP_SCREEN_ON) |
| **Cache** | ✅ IndexedDB + Cache API (persistente) |
| **Offline** | ✅ Funciona offline após primeiro cache |
| **Atualizações** | ❌ Precisa reinstalar APK |
| **Tamanho** | ~10-20 MB (inclui WebView nativo) |
| **Performance** | ⚡ Excelente (WebView nativo) |
| **Permissões** | ✅ Todas as permissões Android |

### PWA (Progressive Web App)

| Característica | PWA |
|---------------|-----|
| **Instalação** | "Adicionar à tela inicial" |
| **Acesso ao sistema** | ⚠️ Limitado (APIs do navegador) |
| **Fullscreen** | ⚠️ Pode sair (depende do navegador) |
| **Tela ligada** | ⚠️ Wake Lock API (pode ser bloqueado) |
| **Cache** | ✅ Service Worker + Cache API |
| **Offline** | ✅ Funciona offline |
| **Atualizações** | ✅ Automáticas (Service Worker) |
| **Tamanho** | ~1-5 MB (só os arquivos web) |
| **Performance** | ⚡ Boa (mas depende do navegador) |
| **Permissões** | ⚠️ Limitadas (navegador) |

## ✅ Vantagens do APK (Capacitor)

### 1. **Fullscreen Permanente**
- ✅ **APK:** Sempre em fullscreen (MainActivity.java força)
- ⚠️ **PWA:** Pode sair do fullscreen (depende do navegador)

### 2. **Tela Sempre Ligada**
- ✅ **APK:** `FLAG_KEEP_SCREEN_ON` nativo (100% confiável)
- ⚠️ **PWA:** Wake Lock API (pode ser bloqueado pelo sistema)

### 3. **Controle Total**
- ✅ **APK:** Acesso a todas as APIs Android
- ⚠️ **PWA:** Limitado às APIs do navegador

### 4. **Performance**
- ✅ **APK:** WebView nativo (mais rápido)
- ⚠️ **PWA:** Depende do navegador instalado

## 📦 Cache e Persistência

### Como Funciona o Cache no Seu App

#### ✅ **IndexedDB (Vídeos)**
- **Armazenamento:** IndexedDB (persistente)
- **Limite:** 5GB por vídeo, até 50 vídeos por tela
- **Persistência:** ✅ **PERMANENTE** - Sobrevive a:
  - Fechar e abrir o app
  - Reiniciar o dispositivo
  - Atualizar o app
  - Limpar cache do navegador (não limpa IndexedDB)

#### ✅ **Cache API (Imagens/HLS)**
- **Armazenamento:** Cache API do Service Worker
- **Persistência:** ✅ **PERMANENTE** - Sobrevive a:
  - Fechar e abrir o app
  - Reiniciar o dispositivo
  - Atualizar o app

#### ✅ **localStorage (Configurações)**
- **Armazenamento:** localStorage
- **Dados salvos:**
  - Código do display
  - Local da tela
  - Device ID
- **Persistência:** ✅ **PERMANENTE**

### 🔄 Mantém Conectado ao Abrir/Fechar?

**SIM!** O app mantém tudo:

1. **Código salvo:** ✅ Permanece no localStorage
2. **Cache de vídeos:** ✅ Permanece no IndexedDB
3. **Cache de imagens:** ✅ Permanece no Cache API
4. **Conexão Supabase:** ✅ Reconecta automaticamente

### 📊 Cache de Arquivos Grandes

#### ✅ **Suporta Arquivos Grandes**

**Configurações atuais:**
- **Limite por vídeo:** 5GB (5.000.000.000 bytes)
- **Timeout de download:** 120 segundos (2 minutos)
- **Armazenamento:** IndexedDB (sem limite de tamanho total)

**Como funciona:**
1. Vídeo é baixado em background
2. Salvo como Blob no IndexedDB
3. Servido com suporte a Range requests
4. Funciona offline após cache completo

**Exemplo:**
- Vídeo de 2GB → ✅ Cacheia normalmente
- Vídeo de 6GB → ⚠️ Pula (acima do limite de 5GB)
- Múltiplos vídeos → ✅ Cacheia até 50 vídeos por tela

## 🎯 Quando Usar Cada Um?

### Use APK (Capacitor) quando:
- ✅ Precisa de fullscreen **sempre ativo**
- ✅ Precisa de tela **sempre ligada** (24h)
- ✅ Precisa de **controle total** do dispositivo
- ✅ É para **uso dedicado** (kiosk, display digital)
- ✅ Não precisa de **atualizações automáticas**

### Use PWA quando:
- ✅ Precisa de **atualizações automáticas**
- ✅ Quer **instalação fácil** (sem APK)
- ✅ Não precisa de **controle total** do sistema
- ✅ É para **uso geral** (não dedicado)

## 📋 Resumo para Seu Caso

### ✅ **APK é MELHOR para você porque:**

1. **Fullscreen permanente** - MainActivity.java força sempre
2. **Tela sempre ligada** - FLAG_KEEP_SCREEN_ON nativo
3. **Cache persistente** - IndexedDB + Cache API
4. **Funciona offline** - Após primeiro cache
5. **Suporta arquivos grandes** - Até 5GB por vídeo
6. **Mantém estado** - Código e cache persistem ao fechar/abrir

### ⚠️ **Única desvantagem:**
- Precisa **reinstalar APK** para atualizar (não atualiza automaticamente)

## 🔧 Melhorias Possíveis

Se quiser melhorar ainda mais o cache:

1. **Aumentar limite de vídeos** (atualmente 50 por tela)
2. **Aumentar limite por vídeo** (atualmente 5GB)
3. **Cache progressivo** (começar a tocar antes de terminar download)
4. **Compressão de cache** (economizar espaço)

---

**Conclusão:** O APK com Capacitor é **perfeito** para seu caso de uso (display 24h), pois oferece controle total e cache persistente robusto! 🎉
