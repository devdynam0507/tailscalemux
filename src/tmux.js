'use strict';

const { execFile } = require('child_process');
const fs = require('fs');

const CANDIDATES = ['/opt/homebrew/bin/tmux', '/usr/local/bin/tmux', '/usr/bin/tmux'];

function resolveBin() {
  for (const p of CANDIDATES) {
    try {
      fs.accessSync(p, fs.constants.X_OK);
      return p;
    } catch (_) {
      /* keep looking */
    }
  }
  return null;
}

const BIN = resolveBin();

function available() {
  return Boolean(BIN);
}

function run(args, { timeout = 10000 } = {}) {
  return new Promise((resolve, reject) => {
    if (!BIN) return reject(new Error('tmux not installed'));
    execFile(BIN, args, { timeout }, (err, stdout, stderr) => {
      if (err) {
        err.stderr = stderr;
        return reject(err);
      }
      resolve(stdout);
    });
  });
}

// tmux session names cannot contain '.' or ':'.
function sanitize(name) {
  return String(name || 'main').replace(/[.:\s]/g, '-') || 'main';
}

// Command used to attach-or-create a session inside the embedded pty.
function attachArgs(session) {
  return ['new-session', '-A', '-s', sanitize(session)];
}

async function listSessions() {
  try {
    const out = await run(['list-sessions', '-F', '#{session_name}\t#{session_windows}\t#{?session_attached,1,0}']);
    return out
      .split('\n')
      .filter(Boolean)
      .map((l) => {
        const [name, windows, attached] = l.split('\t');
        return { name, windows: Number(windows) || 1, attached: attached === '1' };
      });
  } catch (err) {
    // "no server running" => no sessions yet
    return [];
  }
}

function newWindow(session) {
  return run(['new-window', '-t', sanitize(session)]);
}

// dir: 'h' = 좌우(side-by-side), 'v' = 상하(stacked)
function split(session, dir) {
  const flag = dir === 'v' ? '-v' : '-h';
  return run(['split-window', flag, '-t', sanitize(session)]);
}

function killSession(session) {
  return run(['kill-session', '-t', sanitize(session)]);
}

module.exports = {
  BIN,
  available,
  sanitize,
  attachArgs,
  listSessions,
  newWindow,
  split,
  killSession,
};
