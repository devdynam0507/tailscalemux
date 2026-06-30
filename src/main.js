'use strict';

const { app, BrowserWindow, ipcMain, Menu, clipboard, shell } = require('electron');
const path = require('path');
const os = require('os');
const pty = require('node-pty');

const tailscale = require('./tailscale');
const iterm = require('./iterm');
const tmux = require('./tmux');
const hosts = require('./hosts');

let mainWindow = null;
let ptyProc = null;
let currentSession = null; // active tmux session name, or null in bare-shell mode
let respawning = false; // suppress the exit notice during intentional respawns

const SHELL = process.env.SHELL || '/bin/zsh';
const HOME = os.homedir();
const UTF8_LOCALE = 'en_US.UTF-8';

// Apps launched from Finder/Dock inherit no LANG/LC_*, so the pty (and any
// tmux/Claude Code inside it) runs in the C locale and mangles all non-ASCII
// output. Force a UTF-8 locale when the inherited one isn't already UTF-8.
function ptyEnv() {
  const env = { ...process.env, TERM: 'xterm-256color' };
  const cur = env.LC_ALL || env.LC_CTYPE || env.LANG || '';
  if (!/utf-?8/i.test(cur)) {
    env.LANG = UTF8_LOCALE;
    env.LC_ALL = UTF8_LOCALE;
  }
  return env;
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 720,
    minWidth: 760,
    minHeight: 460,
    title: 'Tailscale Switcher',
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#1b1d23',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// Build the command/args for a pty "descriptor".
//   { kind: 'shell' }                  -> plain login shell
//   { kind: 'tmux', session }          -> local tmux attach-or-create
//   { kind: 'ssh', target, user, session } -> remote tmux over Tailscale SSH
function resolveDescriptor(desc) {
  if (desc && desc.kind === 'ssh') {
    const tgt = desc.user ? `${desc.user}@${desc.target}` : desc.target;
    // With a session name -> attach-or-create that exact session (stable
    // workspace). Without one -> attach to whatever session you were last
    // using on that host (create one only if none exist). Either way the
    // remote tmux server keeps the work running across Tailscale switches.
    const tmuxCmd = desc.session
      ? `tmux new-session -A -s ${tmux.sanitize(desc.session)}`
      : `tmux attach || tmux new-session`;
    // Non-interactive ssh on macOS doesn't source ~/.zprofile, so Homebrew's
    // bin (where tmux lives) is missing from PATH. Prepend the usual spots.
    const fixPath = 'export PATH="/opt/homebrew/bin:/usr/local/bin:$HOME/.local/bin:$PATH";';
    // SSH doesn't forward LANG by default; if the remote isn't already UTF-8,
    // force it so tmux/Claude Code render box-drawing & Korean correctly.
    const fixLocale =
      'case "${LC_ALL:-${LC_CTYPE:-$LANG}}" in *UTF-8*|*utf8*) ;; *) export LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8 ;; esac;';
    const remote =
      `${fixLocale} ${fixPath} command -v tmux >/dev/null 2>&1 && { ${tmuxCmd}; } || ` +
      `{ echo "[!] tmux 미설치 — 설치: sudo apt install -y tmux (또는 dnf/brew)"; exec \${SHELL:-sh}; }`;
    const args = [
      '-tt',
      '-o', 'ServerAliveInterval=20',
      '-o', 'ServerAliveCountMax=3',
      '-o', 'StrictHostKeyChecking=accept-new',
      tgt,
      remote,
    ];
    return { cmd: 'ssh', args, session: null };
  }
  if (desc && desc.kind === 'tmux' && tmux.available() && desc.session) {
    return { cmd: tmux.BIN, args: tmux.attachArgs(desc.session), session: tmux.sanitize(desc.session) };
  }
  return { cmd: SHELL, args: ['-l'], session: null };
}

function spawnPty(desc, cols = 80, rows = 24) {
  const { cmd, args, session } = resolveDescriptor(desc);
  currentSession = session;
  try {
    ptyProc = pty.spawn(cmd, args, {
      name: 'xterm-256color',
      cols,
      rows,
      cwd: HOME,
      env: ptyEnv(),
    });
  } catch (err) {
    console.error('[pty] spawn failed:', err && err.message);
    return;
  }
  const self = ptyProc; // capture for identity check in async callbacks
  self.onData((data) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('term:data', data);
    }
  });
  self.onExit(() => {
    // A killed pty's exit can fire AFTER a newer pty replaced it (reattach).
    // Only act if we're still the active pty, or we'd null out the new one
    // and silently drop all input to the live session.
    if (ptyProc !== self) return;
    ptyProc = null;
    if (respawning) return;
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('term:exit');
    }
  });
}

// Convert a session name (or null) into a local descriptor.
function localDesc(session) {
  return session && tmux.available() ? { kind: 'tmux', session } : { kind: 'shell' };
}

function startPty(session, cols = 80, rows = 24) {
  if (ptyProc) return;
  spawnPty(localDesc(session), cols, rows);
}

// Detach from the current pty (tmux session survives) and attach elsewhere.
function reattach(desc, cols = 80, rows = 24) {
  if (ptyProc) {
    respawning = true;
    try {
      ptyProc.kill();
    } catch (_) {
      /* ignore */
    }
    ptyProc = null;
    respawning = false;
  }
  spawnPty(desc, cols, rows);
}

// ---- IPC: terminal ----
ipcMain.on('term:start', (_e, { cols, rows, session }) => startPty(session, cols, rows));
ipcMain.on('term:input', (_e, data) => {
  if (ptyProc) ptyProc.write(data);
});
ipcMain.on('term:resize', (_e, { cols, rows }) => {
  if (ptyProc && cols > 0 && rows > 0) {
    try {
      ptyProc.resize(cols, rows);
    } catch (_) {
      /* ignore transient resize errors */
    }
  }
});

// ---- IPC: tailscale ----
ipcMain.handle('ts:list', async () => tailscale.listProfiles());
ipcMain.handle('ts:status', async () => tailscale.status());
ipcMain.handle('ts:switch', async (_e, id) => {
  const profiles = await tailscale.switchTo(id);
  const status = await tailscale.status();
  return { profiles, status };
});

// ---- IPC: iterm ----
ipcMain.handle('iterm:open', async (_e, { tailnet }) => {
  const cwd = ptyProc ? ptyProc.process && HOME : HOME;
  await iterm.openTab({ tailnet, cwd });
  return true;
});

// ---- IPC: tmux ----
ipcMain.handle('tmux:available', async () => ({
  available: tmux.available(),
  current: currentSession,
}));
ipcMain.handle('tmux:list', async () => tmux.listSessions());
ipcMain.handle('tmux:attach', async (_e, { session, cols, rows }) => {
  reattach(localDesc(session), cols, rows);
  return { current: currentSession };
});
ipcMain.handle('tmux:action', async (_e, { type, session, dir }) => {
  const target = session || currentSession;
  if (!target) throw new Error('no active tmux session');
  if (type === 'new-window') await tmux.newWindow(target);
  else if (type === 'split') await tmux.split(target, dir);
  else if (type === 'kill') await tmux.killSession(target);
  return tmux.listSessions();
});

// ---- IPC: hosts (remote machines) ----
ipcMain.handle('hosts:load', async () => hosts.load());
ipcMain.handle('hosts:upsert', async (_e, host) => hosts.upsert(host));
ipcMain.handle('hosts:remove', async (_e, id) => hosts.remove(id));

// Switch to the host's tailnet (if set) then attach the terminal to its
// remote tmux session over Tailscale SSH.
ipcMain.handle('hosts:connect', async (_e, { host, cols, rows }) => {
  let profiles = null;
  if (host.profileId) {
    const cur = (await tailscale.listProfiles()).find((p) => p.current);
    if (!cur || cur.id !== host.profileId) {
      profiles = await tailscale.switchTo(host.profileId);
    }
  }
  reattach({ kind: 'ssh', target: host.target, user: host.user, session: host.session }, cols, rows);
  return { profiles, status: await tailscale.status() };
});

// Custom menu: keep copy/paste/quit, but free ⌘W / ⌘T / ⌘D for terminal
// split shortcuts (the default Window menu binds ⌘W to Close Window).
function buildMenu() {
  const sendMenu = (action) => mainWindow && mainWindow.webContents.send('menu', action);
  const template = [
    { role: 'appMenu' },
    {
      label: 'Edit',
      submenu: [
        // xterm renders to a canvas, so the default copy/paste roles grab the
        // empty DOM selection. Route these to the renderer's xterm instead.
        { label: 'Copy', accelerator: 'Cmd+C', click: () => sendMenu('copy') },
        { label: 'Paste', accelerator: 'Cmd+V', click: () => sendMenu('paste') },
        { label: 'Select All', accelerator: 'Cmd+A', click: () => sendMenu('selectall') },
      ],
    },
    {
      label: 'View',
      submenu: [{ role: 'reload' }, { role: 'toggleDevTools' }, { type: 'separator' }, { role: 'togglefullscreen' }],
    },
    { label: 'Window', submenu: [{ role: 'minimize' }, { role: 'zoom' }] },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

ipcMain.handle('clip:write', (_e, text) => clipboard.writeText(String(text || '')));
ipcMain.handle('clip:read', () => clipboard.readText());
ipcMain.handle('open-external', (_e, url) => {
  if (/^https?:\/\//i.test(String(url || ''))) shell.openExternal(url);
});

app.whenReady().then(() => {
  buildMenu();
  createWindow();
});

app.on('window-all-closed', () => {
  if (ptyProc) {
    try {
      ptyProc.kill();
    } catch (_) {
      /* ignore */
    }
  }
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
