@echo off
REM Script para gerar APK usando Capacitor (Windows)
REM Este script cria um APK nativo com suporte a fullscreen 24h

echo 🚀 Iniciando build do APK com Capacitor...
echo.

REM Verificar se Node.js está instalado
where node >nul 2>nul
if %ERRORLEVEL% NEQ 0 (
    echo ❌ Node.js não encontrado. Instale Node.js primeiro.
    echo 📥 Baixe em: https://nodejs.org/
    exit /b 1
)

REM Verificar se Java está instalado
where java >nul 2>nul
if %ERRORLEVEL% NEQ 0 (
    echo ⚠️  Java não encontrado. Você precisará do Android Studio para compilar.
    echo 📥 Baixe o Android Studio em: https://developer.android.com/studio
)

echo 📦 Instalando dependências...
call npm install

if %ERRORLEVEL% NEQ 0 (
    echo ❌ Erro ao instalar dependências
    exit /b 1
)

echo 🔨 Fazendo build do projeto...
call npm run build

if %ERRORLEVEL% NEQ 0 (
    echo ❌ Erro ao fazer build
    exit /b 1
)

echo 📱 Sincronizando com Capacitor...
call npx cap sync android

if %ERRORLEVEL% NEQ 0 (
    echo ❌ Erro ao sincronizar Capacitor
    echo 💡 Execute: npm install -g @capacitor/cli
    exit /b 1
)

echo 🎨 Aplicando icone e splash no Android...
call node scripts\sync-android-assets.cjs

if %ERRORLEVEL% NEQ 0 (
    echo ❌ Erro ao aplicar icone/splash Android
    exit /b 1
)

echo.
echo ✅ Build concluído com sucesso!
echo.
echo 📋 Próximos passos:
echo.
echo 1. Abra o Android Studio:
echo    npx cap open android
echo.
echo 2. No Android Studio:
echo    - Vá em: Build ^> Build Bundle(s) / APK(s) ^> Build APK(s)
echo    - OU: Build ^> Generate Signed Bundle / APK
echo    - O APK estará em: android\app\build\outputs\apk\debug\app-debug.apk
echo.
echo 3. Para modo kiosk completo (opcional):
echo    - Configure o dispositivo como "Device Owner" ou "Kiosk Mode"
echo    - Use apps como "Kiosk Browser" ou configure via ADB
echo.
echo 💡 Dica: Para instalar diretamente no dispositivo conectado:
echo    npx cap run android
echo.
pause
