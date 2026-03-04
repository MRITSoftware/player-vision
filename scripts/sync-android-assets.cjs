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
    console.log("[assets] Ícones Android atualizados a partir de icon-192.png.");
  }

  if (fs.existsSync(icon512)) {
    await writePng(icon512, path.join(resDir, "drawable", "splash.png"));
    await writePng(icon512, path.join(resDir, "drawable-night", "splash.png"));
    console.log("[assets] Splash Android atualizado a partir de icon-512.png.");
  }
}

run().catch((err) => {
  console.error("[assets] Erro ao gerar assets Android:", err);
  process.exit(1);
});
