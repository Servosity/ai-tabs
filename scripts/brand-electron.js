// Copy electron.exe → ai-tabs.exe and stamp the icon + version info
// Run after npm install / electron-rebuild
const fs = require('fs');
const path = require('path');

const projectDir = path.join(__dirname, '..');
const pkg = require(path.join(projectDir, 'package.json'));
const src = path.join(projectDir, 'node_modules', 'electron', 'dist', 'electron.exe');
const dest = path.join(projectDir, 'node_modules', 'electron', 'dist', 'ai-tabs.exe');
const icon = path.join(projectDir, 'ai-tabs.ico');

if (!fs.existsSync(src)) {
  console.log('electron.exe not found, skipping branding');
  process.exit(0);
}

// Copy if missing or older
if (!fs.existsSync(dest) || fs.statSync(src).mtimeMs > fs.statSync(dest).mtimeMs) {
  fs.copyFileSync(src, dest);
}

// Create resources/app/ shim so the exe works without the "." argument
// (needed for Windows taskbar pinning which drops command-line args)
const appDir = path.join(projectDir, 'node_modules', 'electron', 'dist', 'resources', 'app');
fs.mkdirSync(appDir, { recursive: true });
fs.writeFileSync(path.join(appDir, 'package.json'), JSON.stringify({
  name: 'ai-tabs',
  main: 'main.js',
}));
// Shim resolves 5 dirs up: app/ → resources/ → dist/ → electron/ → node_modules/ → project root
fs.writeFileSync(path.join(appDir, 'main.js'),
  `require(require('path').resolve(__dirname, '..', '..', '..', '..', '..', 'main.js'));\n`);

// rcedit is ESM-only and Windows-only work; load it after the platform check.
import('rcedit').then(({ rcedit }) => rcedit(dest, {
  icon,
  'version-string': {
    ProductName: 'ai-tabs',
    FileDescription: 'ai-tabs - AI Agent Terminal Manager',
    CompanyName: 'Servosity',
    OriginalFilename: 'ai-tabs.exe',
  },
  'product-version': pkg.version,
  'file-version': pkg.version,
})).then(() => {
  console.log(`Branded ai-tabs.exe (v${pkg.version})`);
}).catch(err => {
  console.error('rcedit failed:', err.message);
  process.exit(1);
});
