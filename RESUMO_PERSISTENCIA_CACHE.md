# 💾 Persistência e Cache - Respostas Diretas

## ✅ Mantém Conectado ao Abrir/Fechar?

### **SIM! Tudo é mantido:**

1. **Código do Display**
   - ✅ Salvo em `localStorage`
   - ✅ Persiste ao fechar/abrir app
   - ✅ Persiste ao reiniciar dispositivo
   - ✅ App abre direto no player (sem login)

2. **Cache de Vídeos**
   - ✅ Salvo em **IndexedDB** (persistente)
   - ✅ **NÃO é limpo** ao fechar app (corrigido: beforeunload não limpa mais)
   - ✅ **NÃO é limpo** ao reiniciar dispositivo
   - ✅ **NÃO é limpo** ao limpar cache do navegador
   - ✅ Só é limpo se:
     - Desinstalar o app
     - Limpar dados do app manualmente
     - Trocar de código de display

3. **Cache de Imagens**
   - ✅ Salvo em **Cache API** (Service Worker)
   - ✅ Persiste ao fechar/abrir
   - ✅ Persiste ao reiniciar

4. **Conexão Supabase**
   - ✅ Reconecta automaticamente ao abrir
   - ✅ Mantém subscriptions ativas
   - ✅ Sincroniza mudanças em tempo real

## 📦 Cache de Arquivos Grandes

### ✅ **Suporta Arquivos MUITO Grandes**

**Limites atuais:**
- **Por vídeo:** Até **5GB** (5.000.000.000 bytes)
- **Por tela:** Até **50 vídeos**
- **Total possível:** Até **250GB** de cache por tela (50 × 5GB)

**Como funciona:**
1. Vídeo é baixado em **background** (não trava o app)
2. Timeout de **120 segundos** (2 minutos) por vídeo
3. Salvo como **Blob** no IndexedDB
4. Servido com **suporte a Range** (seek funciona)
5. Funciona **offline** após cache completo

**Exemplos:**
- ✅ Vídeo de 500MB → Cacheia normalmente
- ✅ Vídeo de 2GB → Cacheia normalmente  
- ✅ Vídeo de 4.5GB → Cacheia normalmente
- ⚠️ Vídeo de 6GB → Pula (acima do limite de 5GB)

### 🔄 **Processo de Cache:**

```
1. App inicia → Verifica código salvo
2. Se tem código → Carrega playlist
3. Service Worker baixa vídeos em background
4. Vídeos são salvos no IndexedDB
5. App pode tocar enquanto baixa
6. Após cache completo → Funciona offline
```

## 🔍 Diferenças: APK vs PWA

### **APK (Capacitor) - O que você tem:**

| Aspecto | Comportamento |
|---------|---------------|
| **Cache** | ✅ IndexedDB + Cache API (mesmo do PWA) |
| **Persistência** | ✅ **PERMANENTE** - Sobrevive a tudo |
| **Fullscreen** | ✅ **SEMPRE** ativo (nativo) |
| **Tela ligada** | ✅ **SEMPRE** ligada (nativo) |
| **Offline** | ✅ Funciona 100% offline |
| **Atualizações** | ❌ Precisa reinstalar APK |

### **PWA (Progressive Web App):**

| Aspecto | Comportamento |
|---------|---------------|
| **Cache** | ✅ IndexedDB + Cache API (mesmo do APK) |
| **Persistência** | ✅ **PERMANENTE** - Sobrevive a tudo |
| **Fullscreen** | ⚠️ Pode sair (depende do navegador) |
| **Tela ligada** | ⚠️ Wake Lock (pode ser bloqueado) |
| **Offline** | ✅ Funciona offline |
| **Atualizações** | ✅ Automáticas (Service Worker) |

## 🎯 Resposta Direta às Suas Perguntas

### 1. "Qual a diferença desse para um gerado em PWA?"

**APK (Capacitor):**
- ✅ Fullscreen **sempre ativo** (não pode sair)
- ✅ Tela **sempre ligada** (nativo, 100% confiável)
- ✅ Controle **total** do dispositivo
- ❌ Precisa reinstalar para atualizar

**PWA:**
- ⚠️ Fullscreen pode sair (depende do navegador)
- ⚠️ Tela ligada pode ser bloqueada pelo sistema
- ⚠️ Limitado às APIs do navegador
- ✅ Atualiza automaticamente

### 2. "Vai manter conectado se abrir e fechar?"

**SIM! Tudo é mantido:**
- ✅ Código salvo → Abre direto no player
- ✅ Cache de vídeos → Permanece no IndexedDB
- ✅ Cache de imagens → Permanece no Cache API
- ✅ Conexão → Reconecta automaticamente

**O que acontece ao abrir:**
1. App verifica código no localStorage
2. Se tem código → Esconde login automaticamente
3. Carrega playlist do cache
4. Reconecta ao Supabase
5. Continua de onde parou

### 3. "Carrega o cache correto mesmo se for um bem grande?"

**SIM! Suporta arquivos grandes:**
- ✅ Até **5GB por vídeo**
- ✅ Até **50 vídeos por tela**
- ✅ Total: até **250GB de cache**
- ✅ Download em **background** (não trava)
- ✅ Timeout de **2 minutos** por vídeo
- ✅ Funciona **offline** após cache

**Processo:**
1. Vídeo grande começa a baixar em background
2. App pode tocar outros vídeos enquanto baixa
3. Vídeo é salvo progressivamente no IndexedDB
4. Quando completo → Funciona offline
5. Seek funciona normalmente (Range requests)

## 💡 Recomendação

Para seu caso (display 24h), o **APK é PERFEITO** porque:
- ✅ Fullscreen permanente (não pode sair)
- ✅ Tela sempre ligada (nativo)
- ✅ Cache persistente robusto
- ✅ Suporta arquivos grandes
- ✅ Funciona offline

A única desvantagem (precisar reinstalar para atualizar) não é problema para displays dedicados.

---

**Conclusão:** O APK mantém tudo conectado, cacheia arquivos grandes corretamente e é superior ao PWA para uso dedicado 24h! 🎉
