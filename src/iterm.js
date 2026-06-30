'use strict';

const { execFile } = require('child_process');

function osascript(script) {
  return new Promise((resolve, reject) => {
    execFile('osascript', ['-e', script], (err, stdout, stderr) => {
      if (err) {
        err.stderr = stderr;
        return reject(err);
      }
      resolve(stdout.trim());
    });
  });
}

function escapeForAS(s) {
  return String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

/**
 * Open a new iTerm2 tab in the given working dir, label it with the tailnet,
 * and print a banner so the user knows which Tailscale profile is active.
 */
async function openTab({ tailnet = '', cwd = '' } = {}) {
  const label = escapeForAS(tailnet || 'tailscale');
  const cdCmd = cwd ? `cd ${escapeForAS(JSON.stringify(cwd))} 2>/dev/null; ` : '';
  const banner = escapeForAS(`${cdCmd}clear; printf '\\033]0;${tailnet}\\007'; echo "▶ Tailscale profile: ${tailnet}"; tailscale status | head -1`);
  const script = `
tell application "iTerm"
  activate
  if (count of windows) = 0 then
    set w to (create window with default profile)
  else
    set w to current window
    tell w to create tab with default profile
  end if
  tell current session of current window
    set name to "${label}"
    write text "${banner}"
  end tell
end tell`;
  return osascript(script);
}

module.exports = { openTab };
