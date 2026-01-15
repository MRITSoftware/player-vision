// Script de inicialização do Capacitor
// Este arquivo deve ser importado no index.html ANTES do player.js

(async function() {
  'use strict';
  
  // Verificar se Capacitor está disponível (só funciona no APK, não no navegador)
  let Capacitor, KeepAwake, StatusBar, SplashScreen;
  let isNative = false;

  try {
    const capacitorCore = await import('@capacitor/core');
    Capacitor = capacitorCore.Capacitor;
    
    const keepAwakeModule = await import('@capacitor-community/keep-awake');
    KeepAwake = keepAwakeModule.KeepAwake;
    
    const statusBarModule = await import('@capacitor/status-bar');
    StatusBar = statusBarModule.StatusBar;
    
    const splashScreenModule = await import('@capacitor/splash-screen');
    SplashScreen = splashScreenModule.SplashScreen;
    
    isNative = Capacitor && Capacitor.isNativePlatform();
    console.log('✅ Capacitor carregado - Plataforma:', Capacitor ? Capacitor.getPlatform() : 'desconhecida');
  } catch (error) {
    console.log('ℹ️ Capacitor não disponível (rodando no navegador) - Funcionalidades nativas desabilitadas');
    Capacitor = null;
    isNative = false;
  }

  // Função para manter tela ligada (24h)
  async function manterTelaLigada() {
    if (isNative && KeepAwake) {
      try {
        await KeepAwake.keepAwake();
        console.log('✅ Tela será mantida ligada (Keep Awake ativado)');
      } catch (error) {
        console.error('❌ Erro ao ativar Keep Awake:', error);
      }
    } else {
      // Fallback para navegador: usar Wake Lock API
      if ('wakeLock' in navigator) {
        try {
          const wakeLock = await navigator.wakeLock.request('screen');
          console.log('✅ Wake Lock ativado (navegador)');
          
          // Reativar se perder o lock
          wakeLock.addEventListener('release', () => {
            console.log('⚠️ Wake Lock foi liberado, tentando reativar...');
            setTimeout(manterTelaLigada, 1000);
          });
        } catch (error) {
          console.warn('⚠️ Wake Lock não disponível:', error);
        }
      } else {
        console.log('ℹ️ Wake Lock API não suportada neste navegador');
      }
    }
  }

  // Configurar Status Bar (esconder em Android)
  async function configurarStatusBar() {
    if (isNative && StatusBar) {
      try {
        await StatusBar.setOverlaysWebView({ overlay: true });
        await StatusBar.setStyle({ style: 'DARK' });
        await StatusBar.setBackgroundColor({ color: '#000000' });
        console.log('✅ Status Bar configurada');
      } catch (error) {
        console.error('❌ Erro ao configurar Status Bar:', error);
      }
    }
  }

  // Esconder Splash Screen
  async function esconderSplashScreen() {
    if (isNative && SplashScreen) {
      try {
        await SplashScreen.hide();
        console.log('✅ Splash Screen escondida');
      } catch (error) {
        console.error('❌ Erro ao esconder Splash Screen:', error);
      }
    }
  }

  // Função para entrar em fullscreen nativo (Android)
  async function entrarFullscreenNativo() {
    if (isNative && Capacitor && Capacitor.getPlatform() === 'android') {
      try {
        // Tentar usar AndroidFullScreen se disponível
        if (window.AndroidFullScreen) {
          window.AndroidFullScreen.immersiveMode();
          console.log('✅ Modo immersive ativado');
        } else if (window.Android && window.Android.fullScreen) {
          window.Android.fullScreen(true);
          console.log('✅ Fullscreen nativo ativado');
        }
      } catch (error) {
        console.warn('⚠️ Erro ao entrar em fullscreen nativo:', error);
      }
    }
  }

  // Inicializar quando DOM estiver pronto
  function inicializar() {
    console.log('🚀 Inicializando Capacitor...');
    console.log('📱 Plataforma:', Capacitor ? Capacitor.getPlatform() : 'web');
    console.log('🌐 É nativo?', isNative);
    
    // Configurar Status Bar
    configurarStatusBar();
    
    // Manter tela ligada
    manterTelaLigada();
    
    // Esconder splash screen após 500ms
    setTimeout(async () => {
      await esconderSplashScreen();
    }, 500);
    
    // Tentar fullscreen nativo
    setTimeout(async () => {
      await entrarFullscreenNativo();
    }, 1000);
    
    // Reativar keep awake periodicamente (a cada 5 minutos)
    setInterval(async () => {
      await manterTelaLigada();
    }, 5 * 60 * 1000);
  }

  // Aguardar DOM estar pronto
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', inicializar);
  } else {
    inicializar();
  }

  // Exportar funções globais
  window.capacitorUtils = {
    manterTelaLigada,
    entrarFullscreenNativo,
    isNative: () => isNative,
    platform: () => Capacitor ? Capacitor.getPlatform() : 'web'
  };

  // Reativar keep awake quando a página ganha foco
  document.addEventListener('visibilitychange', async () => {
    if (!document.hidden) {
      await manterTelaLigada();
      await entrarFullscreenNativo();
    }
  });

  window.addEventListener('focus', async () => {
    await manterTelaLigada();
    await entrarFullscreenNativo();
  });
})();
