'use strict';

const { app } = require('electron');
const fs = require('fs');
const path = require('path');

const FILE = path.join(app.getPath('userData'), 'hosts.json');

function load() {
  try {
    const raw = fs.readFileSync(FILE, 'utf8');
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch (_) {
    return [];
  }
}

function save(hosts) {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(hosts, null, 2));
  return hosts;
}

// id without Date.now()/Math.random() (sandbox-safe): derive from target+label.
function makeId(h) {
  const base = `${h.target || ''}:${h.label || ''}`.replace(/[^a-zA-Z0-9]+/g, '-');
  return base.toLowerCase().replace(/^-+|-+$/g, '') || 'host';
}

function upsert(host) {
  const hosts = load();
  const id = host.id || makeId(host);
  const next = { ...host, id };
  const i = hosts.findIndex((h) => h.id === id);
  if (i >= 0) hosts[i] = next;
  else hosts.push(next);
  save(hosts);
  return hosts;
}

function remove(id) {
  const hosts = load().filter((h) => h.id !== id);
  save(hosts);
  return hosts;
}

module.exports = { load, save, upsert, remove, FILE };
