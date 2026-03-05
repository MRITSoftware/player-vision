const fs = require("fs");
const path = require("path");

let sharp = null;
try {
  sharp = require("sharp");
} catch {
  console.warn("[assets] sharp not found, using copy mode for images.");
}

const root = path.resolve(__dirname, "..");
const androidDir = path.join(root, "android");
const appDir = path.join(androidDir, "app");
const appBuildGradle = path.join(appDir, "build.gradle");
const pluginJavaDir = path.join(appDir, "src", "main", "java", "com", "mritsoftware", "player");
const pluginJavaFile = path.join(pluginJavaDir, "MritExoPlayerPlugin.java");
const icon192 = path.join(root, "icon-192.png");
const icon512 = path.join(root, "icon-512.png");
const resDir = path.join(appDir, "src", "main", "res");

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function writeText(dest, content) {
  ensureDir(path.dirname(dest));
  fs.writeFileSync(dest, content, "utf8");
}

async function writePng(src, dest, size) {
  ensureDir(path.dirname(dest));
  if (sharp && size) {
    await sharp(src).resize(size, size, { fit: "cover" }).png().toFile(dest);
  } else {
    fs.copyFileSync(src, dest);
  }
}

async function writeAdaptiveForeground(src, dest) {
  ensureDir(path.dirname(dest));
  if (!sharp) {
    fs.copyFileSync(src, dest);
    return;
  }
  await sharp(src)
    .resize(432, 432, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toFile(dest);
}

function ensureGradleDependency(dependencyLine) {
  if (!fs.existsSync(appBuildGradle)) return false;
  const source = fs.readFileSync(appBuildGradle, "utf8");
  if (source.includes(dependencyLine)) return true;

  let updated = source;
  const anchor = "    implementation project(':capacitor-cordova-android-plugins')";
  if (updated.includes(anchor)) {
    updated = updated.replace(anchor, `    ${dependencyLine}\n${anchor}`);
  } else {
    const applyFromAnchor = "\n}\n\napply from: 'capacitor.build.gradle'";
    if (!updated.includes(applyFromAnchor)) return false;
    updated = updated.replace(
      applyFromAnchor,
      `    ${dependencyLine}\n}\n\napply from: 'capacitor.build.gradle'`
    );
  }

  fs.writeFileSync(appBuildGradle, updated, "utf8");
  return true;
}

function syncNativeExoPlayer() {
  if (!fs.existsSync(androidDir) || !fs.existsSync(appDir)) {
    console.log("[assets] android/app not found. Skipping native ExoPlayer sync.");
    return;
  }

  const exoDependency = "implementation 'com.google.android.exoplayer:exoplayer:2.19.1'";
  const glideDependency = "implementation 'com.github.bumptech.glide:glide:4.16.0'";
  const depOkExo = ensureGradleDependency(exoDependency);
  const depOkGlide = ensureGradleDependency(glideDependency);
  if (!depOkExo || !depOkGlide) {
    console.warn("[assets] Could not patch all native media dependencies in build.gradle.");
  }

  const pluginJava = `package com.mritsoftware.player;

import android.content.pm.PackageManager;
import android.net.Uri;
import android.graphics.drawable.Drawable;
import android.view.View;
import android.view.ViewGroup;
import android.widget.FrameLayout;
import android.widget.ImageView;
import android.view.TextureView;

import androidx.annotation.NonNull;
import androidx.annotation.Nullable;

import com.bumptech.glide.Glide;
import com.bumptech.glide.request.target.CustomTarget;
import com.bumptech.glide.request.transition.Transition;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.google.android.exoplayer2.ExoPlayer;
import com.google.android.exoplayer2.MediaItem;
import com.google.android.exoplayer2.PlaybackException;
import com.google.android.exoplayer2.Player;
import com.google.android.exoplayer2.database.StandaloneDatabaseProvider;
import com.google.android.exoplayer2.source.MediaSource;
import com.google.android.exoplayer2.source.ProgressiveMediaSource;
import com.google.android.exoplayer2.source.hls.HlsMediaSource;
import com.google.android.exoplayer2.ui.AspectRatioFrameLayout;
import com.google.android.exoplayer2.ui.PlayerView;
import com.google.android.exoplayer2.upstream.DataSpec;
import com.google.android.exoplayer2.upstream.DefaultDataSource;
import com.google.android.exoplayer2.upstream.cache.CacheDataSource;
import com.google.android.exoplayer2.upstream.cache.CacheWriter;
import com.google.android.exoplayer2.upstream.cache.LeastRecentlyUsedCacheEvictor;
import com.google.android.exoplayer2.upstream.cache.SimpleCache;

import java.io.File;
import java.util.Iterator;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;

@CapacitorPlugin(name = "MritExoPlayer")
public class MritExoPlayerPlugin extends Plugin {
    private ExoPlayer player;
    private PlayerView playerView;
    private TextureView textureView;
    private ImageView imageView;
    private FrameLayout overlay;
    private String currentToken = "";
    private String currentUrl = "";
    private boolean initialized = false;
    private SimpleCache simpleCache;
    private CacheDataSource.Factory cacheDataSourceFactory;
    private DefaultDataSource.Factory upstreamFactory;
    private ExecutorService preloadExecutor;
    private Future<?> preloadFuture;
    private static final long CACHE_MAX_BYTES = 700L * 1024L * 1024L;
    private static final long PRELOAD_VIDEO_BYTES = 8L * 1024L * 1024L;

    private boolean isTvBox() {
        try {
            PackageManager pm = getActivity().getPackageManager();
            return pm.hasSystemFeature(PackageManager.FEATURE_LEANBACK) || 
                   pm.hasSystemFeature(PackageManager.FEATURE_TELEVISION);
        } catch (Exception e) {
            return false;
        }
    }

    private final Player.Listener playerListener = new Player.Listener() {
        @Override
        public void onPlaybackStateChanged(int state) {
            if (state == Player.STATE_READY) {
                emitState("ready", null);
            } else if (state == Player.STATE_ENDED) {
                emitState("ended", null);
            } else if (state == Player.STATE_BUFFERING) {
                emitState("buffering", null);
            }
        }

        @Override
        public void onPlayerError(@NonNull PlaybackException error) {
            JSObject extra = new JSObject();
            extra.put("message", error.getMessage() == null ? "unknown error" : error.getMessage());
            emitState("error", extra);
        }
    };

    private void ensureInitialized() {
        if (initialized) return;
        // TV Box fix: configurar ExoPlayer com opções específicas para TV boxes
        ExoPlayer.Builder builder = new ExoPlayer.Builder(getActivity());
        if (isTvBox()) {
            // Para TV boxes, desabilitar algumas otimizações que podem causar problemas
            // O builder já usa configurações padrão compatíveis
        }
        player = builder.build();
        player.addListener(playerListener);
        if (preloadExecutor == null) preloadExecutor = Executors.newSingleThreadExecutor();
        if (cacheDataSourceFactory == null) {
            File cacheDir = new File(getActivity().getCacheDir(), "mrit_exo_cache");
            if (!cacheDir.exists()) cacheDir.mkdirs();
            simpleCache = new SimpleCache(
                    cacheDir,
                    new LeastRecentlyUsedCacheEvictor(CACHE_MAX_BYTES),
                    new StandaloneDatabaseProvider(getActivity())
            );
            DefaultDataSource.Factory upstreamFactory = new DefaultDataSource.Factory(getActivity());
            this.upstreamFactory = upstreamFactory;
            cacheDataSourceFactory = new CacheDataSource.Factory()
                    .setCache(simpleCache)
                    .setUpstreamDataSourceFactory(upstreamFactory)
                    .setFlags(CacheDataSource.FLAG_IGNORE_CACHE_ON_ERROR);
        }

        imageView = new ImageView(getActivity());
        imageView.setLayoutParams(new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT
        ));
        imageView.setScaleType(ImageView.ScaleType.CENTER_CROP);
        imageView.setVisibility(View.GONE);

        playerView = new PlayerView(getActivity());
        playerView.setUseController(false);
        playerView.setPlayer(player);
        playerView.setKeepScreenOn(true);
        playerView.setKeepContentOnPlayerReset(true);
        playerView.setShutterBackgroundColor(android.graphics.Color.TRANSPARENT);
        playerView.setLayoutParams(new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT
        ));
        playerView.setVisibility(View.GONE);
        
        // TV Box fix: criar TextureView separado para TV boxes (mais compatível que SurfaceView)
        if (isTvBox()) {
            textureView = new TextureView(getActivity());
            textureView.setLayoutParams(new FrameLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT,
                    ViewGroup.LayoutParams.MATCH_PARENT
            ));
            textureView.setVisibility(View.GONE);
            // Conectar TextureView ao player
            player.setVideoTextureView(textureView);
        }

        overlay = new FrameLayout(getActivity());
        overlay.setLayoutParams(new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT
        ));
        overlay.setVisibility(View.GONE);
        overlay.addView(imageView);
        overlay.addView(playerView);
        // TV Box fix: adicionar TextureView ao overlay se estiver usando
        if (isTvBox() && textureView != null) {
            overlay.addView(textureView);
        }

        ViewGroup root = getActivity().findViewById(android.R.id.content);
        root.addView(overlay);
        initialized = true;
    }

    private MediaSource buildMediaSource(String url, boolean useCache) {
        MediaItem mediaItem = MediaItem.fromUri(Uri.parse(url));
        if (!useCache || cacheDataSourceFactory == null) {
            if (url != null && url.toLowerCase().contains(".m3u8")) {
                return new HlsMediaSource.Factory(upstreamFactory).createMediaSource(mediaItem);
            }
            return new ProgressiveMediaSource.Factory(upstreamFactory).createMediaSource(mediaItem);
        }
        if (url != null && url.toLowerCase().contains(".m3u8")) {
            return new HlsMediaSource.Factory(cacheDataSourceFactory).createMediaSource(mediaItem);
        }
        return new ProgressiveMediaSource.Factory(cacheDataSourceFactory).createMediaSource(mediaItem);
    }

    private void setResizeMode(String fit) {
        if (playerView == null) return;
        String mode = fit == null ? "cover" : fit.toLowerCase();
        if ("contain".equals(mode)) {
            playerView.setResizeMode(AspectRatioFrameLayout.RESIZE_MODE_FIT);
        } else {
            playerView.setResizeMode(AspectRatioFrameLayout.RESIZE_MODE_ZOOM);
        }
    }

    private void setImageFit(String fit) {
        if (imageView == null) return;
        String mode = fit == null ? "cover" : fit.toLowerCase();
        if ("contain".equals(mode)) {
            imageView.setScaleType(ImageView.ScaleType.FIT_CENTER);
        } else {
            imageView.setScaleType(ImageView.ScaleType.CENTER_CROP);
        }
    }

    private void showVideoLayer() {
        if (overlay == null || playerView == null || imageView == null) return;
        overlay.setVisibility(View.VISIBLE);
        imageView.setVisibility(View.GONE);
        playerView.setVisibility(View.VISIBLE);
        // TV Box fix: mostrar TextureView se estiver usando
        if (isTvBox() && textureView != null) {
            textureView.setVisibility(View.VISIBLE);
        }
    }

    private void showImageLayer() {
        if (overlay == null || playerView == null || imageView == null) return;
        overlay.setVisibility(View.VISIBLE);
        playerView.setVisibility(View.GONE);
        imageView.setVisibility(View.VISIBLE);
    }

    private void emitState(String state, JSObject extra) {
        JSObject payload = new JSObject();
        payload.put("state", state);
        payload.put("token", currentToken);
        payload.put("url", currentUrl);
        if (extra != null) {
            Iterator<String> keys = extra.keys();
            while (keys.hasNext()) {
                String key = keys.next();
                payload.put(key, extra.opt(key));
            }
        }
        notifyListeners("state", payload);
    }

    @PluginMethod
    public void play(PluginCall call) {
        String url = call.getString("url");
        String fit = call.getString("fit", "cover");
        Boolean muted = call.getBoolean("muted", true);
        String token = call.getString("token", "");
        Boolean useCache = call.getBoolean("useCache", true);

        if (url == null || url.trim().isEmpty()) {
            call.reject("url is required");
            return;
        }

        getActivity().runOnUiThread(() -> {
            try {
                ensureInitialized();
                currentToken = token;
                currentUrl = url;
                setResizeMode(fit);
                showVideoLayer();
                Glide.with(getActivity()).clear(imageView);
                
                // TV Box fix: garantir que a view está visível antes de preparar o player
                if (playerView != null && playerView.getVisibility() != View.VISIBLE) {
                    playerView.setVisibility(View.VISIBLE);
                }
                if (overlay != null && overlay.getVisibility() != View.VISIBLE) {
                    overlay.setVisibility(View.VISIBLE);
                }
                if (isTvBox() && textureView != null && textureView.getVisibility() != View.VISIBLE) {
                    textureView.setVisibility(View.VISIBLE);
                }
                
                // TV Box fix: para TV boxes, sempre usar stream direto (sem cache)
                boolean shouldUseCache = (useCache != null && useCache) && !isTvBox();
                
                player.setMediaSource(buildMediaSource(url, shouldUseCache), true);
                player.prepare();
                player.setVolume((muted != null && muted) ? 0f : 1f);
                
                // TV Box fix: pequeno delay antes de play para garantir que a view está pronta
                if (isTvBox()) {
                    View targetView = textureView != null ? textureView : playerView;
                    if (targetView != null) {
                        targetView.postDelayed(new Runnable() {
                            @Override
                            public void run() {
                                if (player != null) {
                                    player.play();
                                }
                            }
                        }, 150);
                    } else {
                        player.play();
                    }
                } else {
                    player.play();
                }
                
                emitState("play_requested", null);
                JSObject ret = new JSObject();
                ret.put("ok", true);
                call.resolve(ret);
            } catch (Exception e) {
                call.reject("play failed: " + e.getMessage(), e);
            }
        });
    }

    @PluginMethod
    public void preload(PluginCall call) {
        String url = call.getString("url");
        String tipo = call.getString("tipo", "video");
        if (url == null || url.trim().isEmpty()) {
            call.reject("url is required");
            return;
        }

        getActivity().runOnUiThread(() -> {
            try {
                ensureInitialized();
                if ("imagem".equalsIgnoreCase(tipo) || "image".equalsIgnoreCase(tipo)) {
                    Glide.with(getActivity()).load(url).preload();
                    JSObject ret = new JSObject();
                    ret.put("ok", true);
                    call.resolve(ret);
                    return;
                }
                if (url.toLowerCase().contains(".m3u8")) {
                    JSObject ret = new JSObject();
                    ret.put("ok", true);
                    ret.put("skipped", "hls_preload_not_supported");
                    call.resolve(ret);
                    return;
                }
                if (url.equals(currentUrl)) {
                    JSObject ret = new JSObject();
                    ret.put("ok", true);
                    ret.put("skipped", "already_current");
                    call.resolve(ret);
                    return;
                }
                if (preloadFuture != null) preloadFuture.cancel(true);
                final String preloadUrl = url;
                preloadFuture = preloadExecutor.submit(() -> {
                    try {
                        DataSpec dataSpec = new DataSpec.Builder()
                                .setUri(Uri.parse(preloadUrl))
                                .setLength(PRELOAD_VIDEO_BYTES)
                                .build();
                        CacheWriter writer = new CacheWriter(
                                cacheDataSourceFactory.createDataSourceForDownloading(),
                                dataSpec,
                                null,
                                null
                        );
                        writer.cache();
                    } catch (Exception ignored) {}
                });
                JSObject ret = new JSObject();
                ret.put("ok", true);
                call.resolve(ret);
            } catch (Exception e) {
                call.reject("preload failed: " + e.getMessage(), e);
            }
        });
    }

    @PluginMethod
    public void showImage(PluginCall call) {
        String url = call.getString("url");
        String fit = call.getString("fit", "cover");
        String token = call.getString("token", "");

        if (url == null || url.trim().isEmpty()) {
            call.reject("url is required");
            return;
        }

        getActivity().runOnUiThread(() -> {
            try {
                ensureInitialized();
                currentToken = token;
                currentUrl = url;
                setImageFit(fit);
                if (player != null) {
                    player.pause();
                    player.clearMediaItems();
                }
                showImageLayer();

                Glide.with(getActivity())
                        .load(url)
                        .timeout(15000)
                        .into(new CustomTarget<Drawable>() {
                            @Override
                            public void onResourceReady(@NonNull Drawable resource, @Nullable Transition<? super Drawable> transition) {
                                imageView.setImageDrawable(resource);
                                emitState("image_ready", null);
                                JSObject ret = new JSObject();
                                ret.put("ok", true);
                                call.resolve(ret);
                            }

                            @Override
                            public void onLoadCleared(@Nullable Drawable placeholder) {
                                imageView.setImageDrawable(placeholder);
                            }

                            @Override
                            public void onLoadFailed(@Nullable Drawable errorDrawable) {
                                imageView.setImageDrawable(errorDrawable);
                                JSObject extra = new JSObject();
                                extra.put("message", "image_load_failed");
                                emitState("image_error", extra);
                                call.reject("image load failed");
                            }
                        });
            } catch (Exception e) {
                call.reject("showImage failed: " + e.getMessage(), e);
            }
        });
    }

    @PluginMethod
    public void stop(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            try {
                if (player != null) {
                    player.stop();
                    player.clearMediaItems();
                }
                if (preloadFuture != null) {
                    preloadFuture.cancel(true);
                    preloadFuture = null;
                }
                if (imageView != null) {
                    Glide.with(getActivity()).clear(imageView);
                    imageView.setImageDrawable(null);
                    imageView.setVisibility(View.GONE);
                }
                if (playerView != null) playerView.setVisibility(View.GONE);
                if (isTvBox() && textureView != null) {
                    textureView.setVisibility(View.GONE);
                    player.setVideoTextureView(null);
                }
                if (overlay != null) overlay.setVisibility(View.GONE);
                emitState("stopped", null);
                JSObject ret = new JSObject();
                ret.put("ok", true);
                call.resolve(ret);
            } catch (Exception e) {
                call.reject("stop failed: " + e.getMessage(), e);
            }
        });
    }

    @Override
    protected void handleOnPause() {
        super.handleOnPause();
        if (player != null) player.pause();
    }

    @Override
    protected void handleOnDestroy() {
        super.handleOnDestroy();
        if (player != null) {
            player.removeListener(playerListener);
            player.release();
            player = null;
        }
        if (preloadFuture != null) {
            preloadFuture.cancel(true);
            preloadFuture = null;
        }
        if (preloadExecutor != null) {
            preloadExecutor.shutdownNow();
            preloadExecutor = null;
        }
        if (simpleCache != null) {
            try { simpleCache.release(); } catch (Exception ignored) {}
            simpleCache = null;
        }
        cacheDataSourceFactory = null;
        if (imageView != null) {
            try { Glide.with(getActivity()).clear(imageView); } catch (Exception ignored) {}
            imageView = null;
        }
        if (isTvBox() && textureView != null) {
            try {
                if (player != null) player.setVideoTextureView(null);
            } catch (Exception ignored) {}
            textureView = null;
        }
        if (overlay != null) overlay.setVisibility(View.GONE);
        initialized = false;
    }
}
`;

  writeText(pluginJavaFile, pluginJava);
  console.log("[assets] Native ExoPlayer plugin synced.");
}

async function syncAndroidIconsAndSplash() {
  if (!fs.existsSync(resDir)) {
    console.log("[assets] android/res not found. Skipping Android assets.");
    return;
  }

  if (!fs.existsSync(icon192)) {
    console.warn("[assets] icon-192.png not found. Launcher icons unchanged.");
  }
  if (!fs.existsSync(icon512)) {
    console.warn("[assets] icon-512.png not found. Splash unchanged.");
  }

  if (fs.existsSync(icon192)) {
    const mipmaps = [
      ["mipmap-mdpi", 48],
      ["mipmap-hdpi", 72],
      ["mipmap-xhdpi", 96],
      ["mipmap-xxhdpi", 144],
      ["mipmap-xxxhdpi", 192],
    ];

    for (const [folder, size] of mipmaps) {
      await writePng(icon192, path.join(resDir, folder, "ic_launcher.png"), size);
      await writePng(icon192, path.join(resDir, folder, "ic_launcher_round.png"), size);
    }
    await writeAdaptiveForeground(icon192, path.join(resDir, "drawable", "ic_launcher_foreground.png"));
    await writeAdaptiveForeground(icon192, path.join(resDir, "drawable", "ic_launcher_foreground_round.png"));

    const v24ForegroundXml = path.join(resDir, "drawable-v24", "ic_launcher_foreground.xml");
    if (fs.existsSync(v24ForegroundXml)) fs.unlinkSync(v24ForegroundXml);

    writeText(
      path.join(resDir, "drawable", "ic_launcher_background.xml"),
      `<?xml version="1.0" encoding="utf-8"?>
<shape xmlns:android="http://schemas.android.com/apk/res/android" android:shape="rectangle">
    <solid android:color="#FFFFFF"/>
</shape>
`
    );

    const adaptiveXml = `<?xml version="1.0" encoding="utf-8"?>
<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">
    <background android:drawable="@drawable/ic_launcher_background"/>
    <foreground android:drawable="@drawable/ic_launcher_foreground"/>
</adaptive-icon>
`;
    const adaptiveRoundXml = `<?xml version="1.0" encoding="utf-8"?>
<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">
    <background android:drawable="@drawable/ic_launcher_background"/>
    <foreground android:drawable="@drawable/ic_launcher_foreground_round"/>
</adaptive-icon>
`;
    writeText(path.join(resDir, "mipmap-anydpi-v26", "ic_launcher.xml"), adaptiveXml);
    writeText(path.join(resDir, "mipmap-anydpi-v26", "ic_launcher_round.xml"), adaptiveRoundXml);

    console.log("[assets] Android launcher icons updated from icon-192.png.");
  }

  if (fs.existsSync(icon512)) {
    await writePng(icon512, path.join(resDir, "drawable", "splash.png"));
    await writePng(icon512, path.join(resDir, "drawable-night", "splash.png"));
    const allSplashFiles = [];
    const stack = [resDir];
    while (stack.length > 0) {
      const current = stack.pop();
      const entries = fs.readdirSync(current, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(current, entry.name);
        if (entry.isDirectory()) {
          stack.push(fullPath);
          continue;
        }
        if (entry.isFile() && entry.name === "splash.png") allSplashFiles.push(fullPath);
      }
    }
    for (const splashPath of allSplashFiles) {
      await writePng(icon512, splashPath);
    }
    console.log("[assets] Android splash updated from icon-512.png.");
  }
}

async function run() {
  if (!fs.existsSync(androidDir)) {
    console.log("[assets] android folder not found. Run 'npx cap add android' first.");
    return;
  }

  syncNativeExoPlayer();
  await syncAndroidIconsAndSplash();
}

run().catch((err) => {
  console.error("[assets] Android sync failed:", err);
  process.exit(1);
});
