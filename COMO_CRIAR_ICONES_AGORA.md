# 🎨 Criar Ícones Obrigatórios Agora

## ⚠️ Problema
O PWA Builder exige ícones PNG quadrados de **192x192** e **512x512** pixels.

## ✅ Solução Rápida (5 minutos)

### Método 1: Editor Online (Mais Fácil)

1. **Acesse:** https://www.iloveimg.com/resize-image
2. **Faça upload** do `vision_logo.png`
3. **Redimensione para 192x192 pixels:**
   - Marque "Manter proporção" (se quiser manter proporção)
   - OU marque "Preencher" (para forçar quadrado)
   - Defina: 192 x 192 pixels
   - Clique em "Redimensionar imagem"
   - **Baixe** e renomeie para `icon-192.png`
4. **Repita para 512x512:**
   - Faça upload do `vision_logo.png` novamente
   - Redimensione para 512x512 pixels
   - **Baixe** e renomeie para `icon-512.png`

### Método 2: Gerador de Favicon

1. **Acesse:** https://realfavicongenerator.net/
2. **Faça upload** do `vision_logo.png`
3. **Configure:**
   - Android Chrome: 192x192 e 512x512
4. **Gere e baixe**
5. **Renomeie:**
   - `android-chrome-192x192.png` → `icon-192.png`
   - `android-chrome-512x512.png` → `icon-512.png`

### Método 3: Photoshop/GIMP

1. Abra o `vision_logo.png`
2. **Para icon-192.png:**
   - Imagem → Tamanho da Imagem → 192x192 pixels
   - Salvar como → `icon-192.png`
3. **Para icon-512.png:**
   - Imagem → Tamanho da Imagem → 512x512 pixels
   - Salvar como → `icon-512.png`

## 📤 Fazer Upload

Após criar os ícones:

1. **Faça upload para o servidor:**
   - `icon-192.png` → `https://mega.mrit.com.br/icon-192.png`
   - `icon-512.png` → `https://mega.mrit.com.br/icon-512.png`

2. **Verifique se estão acessíveis:**
   - Abra: https://mega.mrit.com.br/icon-192.png
   - Abra: https://mega.mrit.com.br/icon-512.png
   - Devem mostrar as imagens (não erro 404)

## ✅ Testar

1. Acesse: https://www.pwabuilder.com/
2. Cole: `https://mega.mrit.com.br`
3. O erro de ícones deve desaparecer
4. Gere o APK normalmente

## 📋 Requisitos

- ✅ Formato: PNG
- ✅ Tamanho exato: 192x192 e 512x512 pixels
- ✅ Quadrado (mesma largura e altura)
- ✅ Localização: Raiz do servidor
- ✅ Nomes: `icon-192.png` e `icon-512.png`

## 💡 Dica

Se o `vision_logo.png` não for quadrado, você pode:
- **Opção A:** Adicionar padding (espaço) para tornar quadrado
- **Opção B:** Cortar para ficar quadrado
- **Opção C:** Usar um editor que force quadrado ao redimensionar
