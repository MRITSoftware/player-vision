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

  await syncAndroidIconsAndSplash();
}

run().catch((err) => {
  console.error("[assets] Android sync failed:", err);
  process.exit(1);
});
