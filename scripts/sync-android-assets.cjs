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
  const depOk = ensureGradleDependency(exoDependency);
  if (!depOk) {
    console.warn("[assets] Could not patch ExoPlayer dependency in build.gradle.");
  }

  const pluginJava = `package com.mritsoftware.player;

import android.net.Uri;
import android.view.View;
import android.view.ViewGroup;
import android.widget.FrameLayout;

import androidx.annotation.NonNull;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.google.android.exoplayer2.ExoPlayer;
import com.google.android.exoplayer2.MediaItem;
import com.google.android.exoplayer2.PlaybackException;
import com.google.android.exoplayer2.Player;
import com.google.android.exoplayer2.ui.AspectRatioFrameLayout;
import com.google.android.exoplayer2.ui.PlayerView;

import java.util.Iterator;

@CapacitorPlugin(name = "MritExoPlayer")
public class MritExoPlayerPlugin extends Plugin {
    private ExoPlayer player;
    private PlayerView playerView;
    private FrameLayout overlay;
    private String currentToken = "";
    private String currentUrl = "";
    private boolean initialized = false;

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
        player = new ExoPlayer.Builder(getActivity()).build();
        player.addListener(playerListener);

        playerView = new PlayerView(getActivity());
        playerView.setUseController(false);
        playerView.setPlayer(player);
        playerView.setKeepScreenOn(true);
        playerView.setLayoutParams(new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT
        ));

        overlay = new FrameLayout(getActivity());
        overlay.setLayoutParams(new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT
        ));
        overlay.setVisibility(View.GONE);
        overlay.addView(playerView);

        ViewGroup root = getActivity().findViewById(android.R.id.content);
        root.addView(overlay);
        initialized = true;
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

    private void emitState(String state, JSObject extra) {
        JSObject payload = new JSObject();
        payload.put("state", state);
        payload.put("token", currentToken);
        payload.put("url", currentUrl);
        if (extra != null) {
            Iterator<String> keys = extra.keys();
            while (keys.hasNext()) {
                String key = keys.next();
                payload.put(key, extra.get(key));
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
                overlay.setVisibility(View.VISIBLE);
                player.setMediaItem(MediaItem.fromUri(Uri.parse(url)));
                player.prepare();
                player.setVolume((muted != null && muted) ? 0f : 1f);
                player.play();
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
    public void stop(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            try {
                if (player != null) {
                    player.stop();
                    player.clearMediaItems();
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
