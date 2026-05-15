# CONTINUAR INOVAÇÕES — MRIT Vision Player

> Sessão pausada em 15/05/2026. Retomar aqui.

---

## O que foi feito nessa sessão

### 1. Screenshot Remoto ✅ (código pronto)
- Player detecta `screenshot_pending = true` na tabela `displays` a cada 6s
- Captura frame atual (canvas), sobe para bucket `screenshots` no Storage
- Grava `screenshot_url` + `screenshot_at` de volta na tabela
- Fallback: se for ExoPlayer nativo, gera placeholder com código + horário

**SQL já rodado pelo usuário** ✅

**Ainda precisa:**
- Confirmar que o bucket `screenshots` foi criado como **Public** no Storage
- Testar: `UPDATE displays SET screenshot_pending = true WHERE codigo_unico = 'SEU_CODIGO';`

---

### 2. Verificação de Integridade do Cache ✅ (código pronto, automático)
- 45s após cache atualizado, o player verifica cada blob de vídeo no IndexedDB
- Tenta decodificar com `<video>` temporário — se duração = null → blob corrompido
- Remove o blob corrompido e pede recache ao Service Worker
- Completamente automático, sem configuração necessária

**Não precisa de nada — já está ativo.**

---

### 3. Feed de Informativos (tipo "feed") 🔴 PENDENTE
Player, iframe e rss-viewer prontos. **Falta só o deploy no servidor.**

**Arquivos criados/modificados:**
- `rss-viewer.html` — reescrito com URL params, cache offline, postMessage
- `index.html` — iframe `#feedPlayer` adicionado
- `player.js` — reconhece `tipo = "feed"`, exibe iframe, avança após N slides
- `supabase/functions/news-feed/index.ts` — Edge Function pronta para deploy

**Pendências para amanhã:**

#### A) SQL no banco
```sql
ALTER TABLE playlist_itens
  ADD COLUMN IF NOT EXISTS feed_query text DEFAULT 'futebol',
  ADD COLUMN IF NOT EXISTS feed_slides integer DEFAULT 3,
  ADD COLUMN IF NOT EXISTS feed_slide_duration integer DEFAULT 7;
```

#### B) Deploy da Edge Function no servidor self-hosted
O usuário tem acesso SSH. Precisa descobrir o caminho do docker-compose
e rodar os comandos abaixo:

```bash
# Adaptar /CAMINHO/ para onde está o docker-compose do Supabase
mkdir -p /CAMINHO/volumes/functions/news-feed
cat > /CAMINHO/volumes/functions/news-feed/index.ts << 'ENDOFFILE'
(copiar conteúdo de supabase/functions/news-feed/index.ts)
ENDOFFILE

# Reiniciar o container de Edge Functions
docker compose restart supabase-edge-runtime
# ou: docker restart supabase-edge-runtime
```

#### C) Configurar secret da API Key no servidor
```bash
# No container ou via variável de ambiente do docker-compose
# Adicionar em environment do serviço edge-runtime:
NEWSDATA_API_KEY=pub_86b13a3fcd134d9c8c7353497d1def09
```

#### D) Testar o feed
Após deploy, no painel adicionar item à playlist com:
- `tipo = "feed"`
- `feed_query = "futebol"`
- `feed_slides = 3`
- `feed_slide_duration = 7`

---

## O que já dá pra testar HOJE

| Funcionalidade | Status | Como testar |
|---|---|---|
| Screenshot remoto | ✅ Pronto | `UPDATE displays SET screenshot_pending = true WHERE codigo_unico = 'XXXXX'` — verificar `screenshot_url` |
| Integridade do cache | ✅ Automático | Ver console do player 45s após carregar — `[cache-integrity]` |
| Player normal (vídeo/imagem/playlist) | ✅ Sem mudanças | Tudo como antes |
| Promo popup | ✅ Sem mudanças | Tudo como antes |

## O que NÃO dá pra testar ainda

| Funcionalidade | Bloqueio |
|---|---|
| Feed de informativos (tipo "feed") | Precisa: SQL + Edge Function deployada + secret da API Key |

---

## Contexto técnico para retomada

- Supabase é **self-hosted** (não é cloud) — login via `npx supabase login` não funciona
- Deploy de Edge Functions é via SSH no servidor + restart do container `supabase-edge-runtime`
- A URL da Edge Function que o player vai chamar é: `https://base.muraltv.com.br/functions/v1/news-feed`
- A variável de ambiente `NEWSDATA_API_KEY` precisa estar no container de Edge Functions

---

## Próximas ideias levantadas (não implementadas)

- **Proof of Play** — log do que foi exibido, quando e por quanto tempo (útil para clientes com anúncios pagos)
- **Ticker de texto** — barra deslizante na base da tela com texto dinâmico
- **Interrupção de emergência** — push imediato de conteúdo urgente para todas as telas
