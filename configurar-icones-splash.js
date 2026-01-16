import sharp from 'sharp';
import { existsSync, mkdirSync, copyFileSync } from 'fs';
import { dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const inputFile = 'vision_logo.png';
const iconSizes = [192, 512];
const androidIconSizes = [
  { folder: 'mipmap-mdpi', size: 48 },
  { folder: 'mipmap-hdpi', size: 72 },
  { folder: 'mipmap-xhdpi', size: 96 },
  { folder: 'mipmap-xxhdpi', size: 144 },
  { folder: 'mipmap-xxxhdpi', size: 192 }
];

async function generateIcons() {
  if (!existsSync(inputFile)) {
    console.error(`❌ Arquivo ${inputFile} não encontrado!`);
    process.exit(1);
  }

  console.log(`🎨 Gerando ícones a partir de ${inputFile}...\n`);

  // 1. Gerar ícones PWA (icon-192.png e icon-512.png) se não existirem
  console.log('📱 Gerando ícones PWA...');
  for (const size of iconSizes) {
    const outputFile = `icon-${size}.png`;
    if (!existsSync(outputFile)) {
      try {
        await sharp(inputFile)
          .resize(size, size, {
            fit: 'contain',
            background: { r: 255, g: 255, b: 255, alpha: 0 } // Fundo transparente
          })
          .toFile(outputFile);
        
        console.log(`   ✅ ${outputFile} gerado (${size}x${size}px)`);
      } catch (error) {
        console.error(`   ❌ Erro ao gerar ${outputFile}:`, error.message);
      }
    } else {
      console.log(`   ℹ️  ${outputFile} já existe, pulando...`);
    }
  }

  // 2. Gerar ícones para Android (mipmap folders)
  console.log('\n📱 Gerando ícones Android...');
  const androidPath = 'android/app/src/main/res';
  
  if (existsSync(androidPath)) {
    for (const { folder, size } of androidIconSizes) {
      try {
        const mipmapPath = `${androidPath}/${folder}`;
        if (!existsSync(mipmapPath)) {
          mkdirSync(mipmapPath, { recursive: true });
        }
        
        const outputFile = `${mipmapPath}/ic_launcher.png`;
        
        await sharp(inputFile)
          .resize(size, size, {
            fit: 'contain',
            background: { r: 0, g: 0, b: 0, alpha: 0 }
          })
          .toFile(outputFile);
        
        console.log(`   ✅ ${outputFile} gerado (${size}x${size}px)`);
      } catch (error) {
        console.error(`   ❌ Erro ao gerar ícone ${folder}:`, error.message);
      }
    }
    
    // Gerar também o ícone redondo (ic_launcher_round)
    console.log('\n📱 Gerando ícones redondos Android...');
    for (const { folder, size } of androidIconSizes) {
      try {
        const mipmapPath = `${androidPath}/${folder}`;
        if (!existsSync(mipmapPath)) {
          mkdirSync(mipmapPath, { recursive: true });
        }
        
        const outputFile = `${mipmapPath}/ic_launcher_round.png`;
        
        await sharp(inputFile)
          .resize(size, size, {
            fit: 'contain',
            background: { r: 0, g: 0, b: 0, alpha: 0 }
          })
          .toFile(outputFile);
        
        console.log(`   ✅ ${outputFile} gerado (${size}x${size}px)`);
      } catch (error) {
        console.error(`   ❌ Erro ao gerar ícone redondo ${folder}:`, error.message);
      }
    }
  } else {
    console.log(`   ⚠️  Pasta Android não encontrada (${androidPath})`);
    console.log(`   ℹ️  Execute 'npx cap sync' primeiro para criar a estrutura`);
  }

  // 3. Gerar splash screen para Android
  console.log('\n🖼️  Gerando splash screen Android...');
  const drawablePath = `${androidPath}/drawable`;
  const splashSourceFile = 'vision_logo.png';
  
  if (existsSync(androidPath)) {
    try {
      if (!existsSync(splashSourceFile)) {
        console.error(`   ❌ Arquivo ${splashSourceFile} não encontrado!`);
        console.log(`   ℹ️  O splash screen precisa do arquivo vision_logo.png na raiz do projeto`);
        return;
      }
      
      if (!existsSync(drawablePath)) {
        mkdirSync(drawablePath, { recursive: true });
      }
      
      // Splash screen geralmente usa 1080x1920 (portrait) ou 1920x1080 (landscape)
      // Como o app é landscape, vamos criar 1920x1080
      const splashFile = `${drawablePath}/splash.png`;
      
      await sharp(splashSourceFile)
        .resize(1920, 1080, {
          fit: 'contain',
          background: { r: 0, g: 0, b: 0, alpha: 1 } // Fundo preto
        })
        .toFile(splashFile);
      
      console.log(`   ✅ ${splashFile} gerado (1920x1080px) a partir de ${splashSourceFile}`);
    } catch (error) {
      console.error(`   ❌ Erro ao gerar splash screen:`, error.message);
    }
  } else {
    console.log(`   ⚠️  Pasta Android não encontrada (${androidPath})`);
    console.log(`   ℹ️  Execute 'npx cap sync' primeiro para criar a estrutura`);
  }

  console.log('\n✅ Configuração concluída!');
  console.log('\n📋 Próximos passos:');
  console.log('   1. Os ícones do Android foram gerados a partir de vision_logo.png');
  console.log('   2. Os ícones PWA (icon-192.png e icon-512.png) foram gerados');
  console.log('   3. Execute: npm run capacitor:sync');
  console.log('   4. O splash screen e ícones do Android estão configurados com vision_logo.png');
}

generateIcons().catch(console.error);
