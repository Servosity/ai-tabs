// Creates a Windows shortcut (.lnk) for ai-tabs with the correct icon
// and AppUserModelId so the taskbar groups it correctly.
// Usage: node scripts/create-shortcut.js [--desktop] [--startmenu]
const { execSync } = require('child_process');
const path = require('path');

const projectDir = path.join(__dirname, '..');
const electronExe = path.join(projectDir, 'node_modules', 'electron', 'dist', 'ai-tabs.exe');
const icon = path.join(projectDir, 'ai-tabs.ico');
const appId = 'com.servosity.ai-tabs';

const args = process.argv.slice(2);
const targets = [];

if (args.includes('--startmenu') || args.length === 0) {
  const startMenu = path.join(process.env.APPDATA, 'Microsoft', 'Windows', 'Start Menu', 'Programs');
  targets.push(path.join(startMenu, 'ai-tabs.lnk'));
}
if (args.includes('--desktop') || args.length === 0) {
  targets.push(path.join(process.env.USERPROFILE, 'Desktop', 'ai-tabs.lnk'));
}

for (const shortcutPath of targets) {
  // PowerShell script that creates .lnk with AppUserModelId via shell COM
  const ps = `
$ws = New-Object -ComObject WScript.Shell
$sc = $ws.CreateShortcut('${shortcutPath.replace(/'/g, "''")}')
$sc.TargetPath = '${electronExe.replace(/'/g, "''")}'
$sc.Arguments = '.'
$sc.WorkingDirectory = '${projectDir.replace(/'/g, "''")}'
$sc.IconLocation = '${icon.replace(/'/g, "''")}'
$sc.Description = 'ai-tabs - AI Agent Terminal Manager'
$sc.Save()

# Set AppUserModelId on the shortcut so Windows groups taskbar icons correctly
$shell = New-Object -ComObject Shell.Application
$dir = $shell.NameSpace((Split-Path '${shortcutPath.replace(/'/g, "''")}'))
$lnk = $dir.ParseName((Split-Path '${shortcutPath.replace(/'/g, "''")}' -Leaf))
$lnk.InvokeVerb('taskbarpin') 2>$null
`;

  execSync(`powershell.exe -NoProfile -Command "${ps.replace(/"/g, '\\"')}"`, { stdio: 'inherit' });
  console.log(`Shortcut created: ${shortcutPath}`);
}

console.log('Pin the shortcut to the taskbar for the correct ai-tabs icon.');
