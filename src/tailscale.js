'use strict';

const { execFile } = require('child_process');
const fs = require('fs');

// Tailscale CLI is not always on Electron's PATH, so resolve it explicitly.
const CANDIDATES = [
  '/usr/local/bin/tailscale',
  '/opt/homebrew/bin/tailscale',
  '/Applications/Tailscale.app/Contents/MacOS/Tailscale',
];

function resolveBin() {
  for (const p of CANDIDATES) {
    try {
      fs.accessSync(p, fs.constants.X_OK);
      return p;
    } catch (_) {
      /* keep looking */
    }
  }
  return 'tailscale'; // fall back to PATH
}

const BIN = resolveBin();

function run(args, { timeout = 30000 } = {}) {
  return new Promise((resolve, reject) => {
    execFile(BIN, args, { timeout }, (err, stdout, stderr) => {
      if (err) {
        err.stderr = stderr;
        return reject(err);
      }
      resolve(stdout);
    });
  });
}

/**
 * Parse `tailscale switch --list` into account profiles.
 * The current profile is the row whose Account column ends with '*'.
 */
async function listProfiles() {
  const out = await run(['switch', '--list']);
  const lines = out.split('\n').map((l) => l.trimEnd());
  const profiles = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    if (/^ID\s+Tailnet\s+Account/i.test(line)) continue; // header
    const parts = line.trim().split(/\s+/);
    if (parts.length < 3) continue;
    const [id, tailnet] = parts;
    let account = parts.slice(2).join(' ');
    const current = account.endsWith('*');
    if (current) account = account.slice(0, -1);
    profiles.push({ id, tailnet, account, current });
  }
  return profiles;
}

async function switchTo(id) {
  // `tailscale switch` blocks until the profile is active (can take a few seconds).
  await run(['switch', id], { timeout: 60000 });
  return listProfiles();
}

/**
 * Lightweight status for the header: backend state, self DNS name and IPs.
 */
async function status() {
  try {
    const out = await run(['status', '--json'], { timeout: 15000 });
    const j = JSON.parse(out);
    const self = j.Self || {};
    return {
      backendState: j.BackendState || 'Unknown',
      dnsName: (self.DNSName || '').replace(/\.$/, ''),
      ips: self.TailscaleIPs || [],
      tailnet: (j.CurrentTailnet && j.CurrentTailnet.Name) || '',
    };
  } catch (err) {
    return { backendState: 'Error', dnsName: '', ips: [], tailnet: '', error: String(err.stderr || err.message) };
  }
}

module.exports = { listProfiles, switchTo, status, BIN };
