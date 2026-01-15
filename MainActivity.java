package com.mritsoftware.player;

import android.os.Bundle;
import android.view.View;
import android.view.Window;
import android.view.WindowInsets;
import android.view.WindowInsetsController;
import android.view.WindowManager;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    private Handler handler = new Handler(Looper.getMainLooper());
    
    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        
        // Manter tela ligada
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        
        // Esconder barra de status e navegação imediatamente
        entrarFullscreenImersivo();
        
        // Reaplicar fullscreen quando a janela ganha foco
        getWindow().getDecorView().setOnSystemUiVisibilityChangeListener(
            new View.OnSystemUiVisibilityChangeListener() {
                @Override
                public void onSystemUiVisibilityChange(int visibility) {
                    // Se as barras apareceram, esconder novamente
                    if ((visibility & View.SYSTEM_UI_FLAG_FULLSCREEN) == 0) {
                        handler.postDelayed(new Runnable() {
                            @Override
                            public void run() {
                                entrarFullscreenImersivo();
                            }
                        }, 100);
                    }
                }
            }
        );
    }
    
    /**
     * Entra em modo fullscreen imersivo (esconde todas as barras)
     * Usa WindowInsetsController para Android 11+ e setSystemUiVisibility para versões antigas
     */
    private void entrarFullscreenImersivo() {
        View decorView = getWindow().getDecorView();
        
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            // Android 11+ (API 30+) - Usa WindowInsetsController
            WindowInsetsController controller = decorView.getWindowInsetsController();
            if (controller != null) {
                controller.hide(WindowInsets.Type.statusBars() | WindowInsets.Type.navigationBars());
                controller.setSystemBarsBehavior(WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
            }
        } else if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.KITKAT) {
            // Android 4.4+ até Android 10 - Usa setSystemUiVisibility
            int uiOptions = View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                    | View.SYSTEM_UI_FLAG_FULLSCREEN
                    | View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
                    | View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                    | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
                    | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN;
            decorView.setSystemUiVisibility(uiOptions);
        }
    }
    
    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        if (hasFocus) {
            // Reaplicar fullscreen quando ganha foco
            handler.postDelayed(new Runnable() {
                @Override
                public void run() {
                    entrarFullscreenImersivo();
                }
            }, 100);
        }
    }
    
    @Override
    public void onResume() {
        super.onResume();
        // Reaplicar fullscreen ao retornar
        handler.postDelayed(new Runnable() {
            @Override
            public void run() {
                entrarFullscreenImersivo();
            }
        }, 100);
    }
    
    @Override
    public void onStart() {
        super.onStart();
        // Reaplicar fullscreen ao iniciar
        handler.postDelayed(new Runnable() {
            @Override
            public void run() {
                entrarFullscreenImersivo();
            }
        }, 100);
    }
    
    @Override
    public void onPause() {
        super.onPause();
        // Reaplicar fullscreen ao pausar (caso volte)
        entrarFullscreenImersivo();
    }
}
