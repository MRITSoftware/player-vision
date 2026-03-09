@echo off
REM Script para gerar APK usando PWA Builder (Windows)

echo 🚀 Iniciando build do APK...

REM Verificar se Node.js está instalado
where node >nul 2>nul
if %ERRORLEVEL% NEQ 0 (
    echo ❌ Node.js não encontrado. Instale Node.js primeiro.
    exit /b 1
)

REM Instalar dependências
echo 📦 Instalando dependências...
call npm install

REM Build do projeto
echo 🔨 Fazendo build do projeto...
call npm run build

REM Verificar se os ícones existem
if not exist "icon-192.png" (
    echo ⚠️  Ícones não encontrados. Por favor, adicione icon-192.png e icon-512.png
    exit /b 1
)

if not exist "icon-512.png" (
    echo ⚠️  Ícones não encontrados. Por favor, adicione icon-192.png e icon-512.png
    exit /b 1
)

REM Instalar PWA Builder CLI
echo 📱 Instalando PWA Builder CLI...
call npm install -g @pwabuilder/cli

REM Gerar APK
echo 🔨 Gerando APK...
call pwabuilder android --manifest ./manifest.json --package com.mritsoftware.player --name "MRIT Player" --short-name "MRIT" --display standalone --orientation portrait --theme-color "#000000" --background-color "#000000" --skipPwaValidation

echo ✅ APK gerado com sucesso!
echo 📦 O APK está em: .\android\app\build\outputs\apk\

pause
