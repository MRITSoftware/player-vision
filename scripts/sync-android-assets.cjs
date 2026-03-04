const fs = require("fs");
const path = require("path");

let sharp = null;
try {
  sharp = require("sharp");
} catch (e) {
  console.warn("[assets] sharp não encontrado, usando cópia sem redimensionar.");
}

const root = path.resolve(__dirname, "..");
const icon192 = path.join(root, "icon-192.png");
const icon512 = path.join(root, "icon-512.png");
const resDir = path.join(root, "android", "app", "src", "main", "res");

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
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
  // Tamanho ideal do foreground para adaptive icon.
  // "contain" evita cortar logo ao aplicar máscara do launcher.
  await sharp(src)
    .resize(432, 432, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toFile(dest);
}

function writeText(dest, content) {
  ensureDir(path.dirname(dest));
  fs.writeFileSync(dest, content, "utf8");
}

async function run() {
  if (!fs.existsSync(resDir)) {
    console.log("[assets] Pasta android/res não encontrada. Pulei geração de assets Android.");
    return;
  }

  if (!fs.existsSync(icon192)) {
    console.warn("[assets] icon-192.png não encontrado. Ícone Android não atualizado.");
  }
  if (!fs.existsSync(icon512)) {
    console.warn("[assets] icon-512.png não encontrado. Splash Android não atualizado.");
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
    // Adaptive icon (Android 8+): usado na miniatura da home e gaveta de apps.
    await writeAdaptiveForeground(icon192, path.join(resDir, "drawable", "ic_launcher_foreground.png"));
    await writeAdaptiveForeground(icon192, path.join(resDir, "drawable", "ic_launcher_foreground_round.png"));
    // O template Android cria drawable-v24/ic_launcher_foreground.xml (ícone genérico do Android).
    // Em API 24+, esse XML pode sobrescrever nosso PNG customizado com o mesmo resource name.
    // Removemos para garantir que o launcher use o ícone gerado a partir de icon-192.png.
    const v24ForegroundXml = path.join(resDir, "drawable-v24", "ic_launcher_foreground.xml");
    if (fs.existsSync(v24ForegroundXml)) {
      fs.unlinkSync(v24ForegroundXml);
    }

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

    console.log("[assets] Ícones Android (legacy + adaptive) atualizados a partir de icon-192.png.");
  }

  if (fs.existsSync(icon512)) {
    await writePng(icon512, path.join(resDir, "drawable", "splash.png"));
    await writePng(icon512, path.join(resDir, "drawable-night", "splash.png"));
    // O Android pode preferir recursos de densidade/orientação (drawable-port-*/drawable-land-*).
    // Se esses arquivos ficarem no padrão do template, o splash exibido não será o icon-512.
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
        if (entry.isFile() && entry.name === "splash.png") {
          allSplashFiles.push(fullPath);
        }
      }
    }
    for (const splashPath of allSplashFiles) {
      await writePng(icon512, splashPath);
    }
    console.log("[assets] Splash Android atualizado a partir de icon-512.png.");
  }
}

run().catch((err) => {
  console.error("[assets] Erro ao gerar assets Android:", err);
  process.exit(1);
});
