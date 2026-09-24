const fs = require('fs');
const { spawnSync } = require('child_process');

/**
 * Move a directory to the OS trash (Recycle Bin on Windows).
 * The server runs as plain Node (spawned with ELECTRON_RUN_AS_NODE=1), so
 * Electron's shell.trashItem is unavailable — shell out per platform instead.
 * Throws on any failure; NEVER falls back to permanent deletion.
 */
function trashDirSync(dirPath) {
  if (!fs.existsSync(dirPath) || !fs.statSync(dirPath).isDirectory()) {
    throw new Error(`Not a directory: ${dirPath}`);
  }

  if (process.platform === 'win32') {
    // VisualBasic FileIO is the only stock Windows API that recycles.
    const escaped = dirPath.replace(/'/g, "''");
    const cmd = 'Add-Type -AssemblyName Microsoft.VisualBasic; '
      + `[Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory('${escaped}', 'OnlyErrorDialogs', 'SendToRecycleBin')`;
    const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', cmd], { encoding: 'utf8', timeout: 30000 });
    if (r.status !== 0) {
      throw new Error(`Recycle Bin move failed: ${(r.stderr || '').trim() || `exit ${r.status}`}`);
    }
  } else if (process.platform === 'darwin') {
    const r = spawnSync('osascript', ['-e', `tell application "Finder" to delete POSIX file "${dirPath}"`], { encoding: 'utf8', timeout: 30000 });
    if (r.status !== 0) {
      throw new Error(`Trash failed: ${(r.stderr || '').trim() || `exit ${r.status}`}`);
    }
  } else {
    const r = spawnSync('gio', ['trash', dirPath], { encoding: 'utf8', timeout: 30000 });
    if (r.status !== 0) {
      throw new Error(`Trash failed: ${(r.stderr || '').trim() || `exit ${r.status}`}`);
    }
  }
}

module.exports = { trashDirSync };
