# 🔍 Como Debugar o APK

Quando o APK não funciona como esperado, você precisa ver os logs do console. Aqui está como fazer:

## 📱 Método 1: Chrome DevTools Remoto (Recomendado)

### Passo a Passo:

1. **Conecte o dispositivo Android via USB**
   - Ative "Depuração USB" nas configurações do Android
   - Autorize o computador quando solicitado

2. **No computador, abra o Chrome**
   - Digite na barra de endereços: `chrome://inspect`
   - Ou vá em: Menu → Mais ferramentas → Ferramentas do desenvolvedor remoto

3. **Encontre seu app**
   - Na lista "Remote Target", procure por "MRIT Player"
   - Clique em "inspect"

4. **Veja os logs**
   - Abra a aba "Console"
   - Todos os `console.log()` do app aparecerão aqui
   - Erros também aparecerão em vermelho

5. **Teste novamente**
   - No dispositivo, abra o app
   - Digite o código
   - Veja os logs aparecerem no Chrome

## 📋 O que procurar nos logs:

### ✅ Logs normais:
- `🚀 iniciar() chamada` - Função foi chamada
- `📝 Código digitado: XXX` - Código foi capturado
- `✅ Código válido, continuando...` - Validação passou
- `🔗 Verificando se código já está em uso...` - Verificando no banco

### ❌ Possíveis erros:
- `❌ Campo codigoTela não encontrado!` - HTML não carregou
- `❌ startPlayer não é uma função!` - JavaScript não carregou
- `❌ Erro ao buscar display:` - Problema com Supabase
- `❌ Erro na validação:` - Problema ao verificar código

## 🔧 Método 2: Logcat (Android Studio/ADB)

Se não conseguir usar Chrome DevTools:

```bash
# Conecte o dispositivo e execute:
adb logcat | grep -i "chromium\|console\|mrit"

# Ou veja todos os logs:
adb logcat
```

## 🐛 Problemas Comuns:

### 1. "Nada acontece quando clico"
- **Verifique:** Console mostra `🔘 Botão clicado`?
- **Se não:** O evento não está sendo anexado
- **Solução:** Verifique se `player.js` carregou

### 2. "Código não é aceito"
- **Verifique:** Console mostra `📝 Código digitado: XXX`?
- **Se não:** Campo não está sendo lido
- **Se sim:** Veja o erro que aparece depois

### 3. "Erro de conexão"
- **Verifique:** `📡 Status online: true/false`
- **Se false:** Dispositivo sem internet
- **Se true mas erro:** Problema com Supabase

### 4. "Supabase não disponível"
- **Verifique:** `🔗 Supabase client: disponível/NÃO DISPONÍVEL`
- **Se NÃO DISPONÍVEL:** Script do Supabase não carregou
- **Solução:** Verifique conexão ou CDN

## 📝 Logs Adicionados:

Os seguintes logs foram adicionados para facilitar o debug:

- `🔍 Debug - Verificando funções disponíveis` - No carregamento da página
- `🔘 Botão clicado` - Quando botão é pressionado
- `🚀 iniciar() chamada` - Quando função iniciar é chamada
- `📝 Código digitado: XXX` - Código que foi digitado
- `✅ Código válido, continuando...` - Validação passou
- `🔗 Verificando se código já está em uso...` - Verificando no banco
- `📊 Resultado da verificação:` - Resultado da verificação

## 💡 Dica:

**Sempre teste primeiro no navegador** antes de gerar o APK:
1. Abra `index.html` no Chrome
2. Abra DevTools (F12)
3. Teste o fluxo completo
4. Se funcionar no navegador, deve funcionar no APK

## 🆘 Se ainda não funcionar:

1. **Capture os logs** usando Chrome DevTools
2. **Tire screenshots** dos erros
3. **Verifique:**
   - Conexão com internet
   - URL do Supabase está correta
   - Código existe no banco de dados
   - Permissões de internet no AndroidManifest.xml

---

**Última atualização:** 2025-01-27
