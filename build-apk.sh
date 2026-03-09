#!/bin/bash
# Script para gerar APK usando PWA Builder

echo "🚀 Iniciando build do APK..."

# Verificar se Node.js está instalado
if ! command -v node &> /dev/null; then
    echo "❌ Node.js não encontrado. Instale Node.js primeiro."
    exit 1
fi

# Instalar dependências
echo "📦 Instalando dependências..."
npm install

# Build do projeto
echo "🔨 Fazendo build do projeto..."
npm run build

# Verificar se os ícones existem
if [ ! -f "icon-192.png" ] || [ ! -f "icon-512.png" ]; then
    echo "⚠️  Ícones não encontrados. Por favor, adicione icon-192.png e icon-512.png"
    exit 1
fi

# Instalar PWA Builder CLI
echo "📱 Instalando PWA Builder CLI..."
npm install -g @pwabuilder/cli

# Gerar APK
echo "🔨 Gerando APK..."
pwabuilder android \
  --manifest ./manifest.json \
  --package com.mritsoftware.player \
  --name "MRIT Player" \
  --short-name "MRIT" \
  --display standalone \
  --orientation portrait \
  --theme-color "#000000" \
  --background-color "#000000" \
  --skipPwaValidation

echo "✅ APK gerado com sucesso!"
echo "📦 O APK está em: ./android/app/build/outputs/apk/"
