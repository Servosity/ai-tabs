// `npm start` on every OS: the branded ai-tabs.exe on Windows (so the taskbar
// shows ai-tabs, not Electron), the stock Electron binary elsewhere.
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const projectDir = path.join(__dirname, '..');
const brandedExe = path.join(projectDir, 'node_modules', 'electron', 'dist', 'ai-tabs.exe');
const binary = process.platform === 'win32' && fs.existsSync(brandedExe)
  ? brandedExe
  : require('electron'); // the electron package exports its binary's path

const child = spawn(binary, ['.'], { cwd: projectDir, stdio: 'inherit' });
child.on('exit', (code) => process.exit(code == null ? 1 : code));
