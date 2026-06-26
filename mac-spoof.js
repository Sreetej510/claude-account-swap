'use strict';

const cp = require('child_process');
const spoof = require('spoof');

const SETTLE_MS = 5000; // time for Windows async registry + netsh ops to complete

// ── interface discovery ───────────────────────────────────────────────────────

// On Windows, find the adapter name that owns the default gateway route.
function _primaryAdapterNameWin32() {
  const output = cp.execSync('ipconfig /all', { stdio: 'pipe', encoding: 'utf8' });
  const lines = output.split(/\r?\n/);
  let currentAdapter = null;

  for (const line of lines) {
    const adapterMatch = /^[A-Za-z].*adapter (.+?):/.exec(line);
    if (adapterMatch) {
      currentAdapter = adapterMatch[1];
      continue;
    }
    if (currentAdapter) {
      const gwMatch = /Default Gateway.+?:\s*(.+)/.exec(line);
      if (gwMatch) {
        const gw = gwMatch[1].trim().replace(/\s*\(Preferred\)/, '');
        // Must be a real IPv4/IPv6 address, not blank
        if (gw && /^[\d.a-fA-F:]+$/.test(gw)) {
          return currentAdapter;
        }
      }
    }
  }
  return null;
}

function findPrimaryInterface() {
  if (process.platform === 'win32') {
    const name = _primaryAdapterNameWin32();
    if (name) {
      const list = spoof.findInterfaces([name]);
      if (list && list[0]) return list[0];
    }
  }
  // macOS / Linux: return first non-loopback
  const list = spoof.findInterfaces([]);
  return (list && list[0]) || null;
}

// ── MAC helpers ───────────────────────────────────────────────────────────────

function randomMac() {
  return spoof.randomize(false); // uses VM-vendor prefixes, proper Windows prefixes
}

function normalizeMac(mac) {
  return spoof.normalize(mac); // → "AA:BB:CC:DD:EE:FF"
}

// Given list of MACs already in use and the current MAC,
// return a MAC to store for a new account (unique, never collides).
function assignUniqueMac(usedMacs, currentMac) {
  const used = usedMacs.map(m => m && normalizeMac(m)).filter(Boolean);
  const norm = currentMac && normalizeMac(currentMac);
  if (norm && !used.includes(norm)) return norm;
  // Current MAC is already taken — generate a fresh random one.
  let candidate;
  do { candidate = randomMac(); } while (used.includes(normalizeMac(candidate)));
  return candidate;
}

// ── admin check ───────────────────────────────────────────────────────────────

function isAdmin() {
  if (process.platform !== 'win32') {
    return process.getuid && process.getuid() === 0;
  }
  try {
    cp.execSync('net session', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

// ── apply MAC ─────────────────────────────────────────────────────────────────

// Returns { device, oldMac, newMac, skipped, warning }
async function applyMac(targetMac) {
  const iface = findPrimaryInterface();
  if (!iface) throw new Error('No primary network interface found');

  const normalized = normalizeMac(targetMac);
  const current = iface.currentAddress ? normalizeMac(iface.currentAddress) : null;

  if (current && current.toUpperCase() === normalized.toUpperCase()) {
    return { device: iface.device, oldMac: current, newMac: normalized, skipped: true };
  }

  if (!isAdmin()) {
    return {
      device: iface.device,
      oldMac: current,
      newMac: normalized,
      skipped: false,
      warning: 'Run as Administrator to apply MAC spoofing',
    };
  }

  // setInterfaceMAC is synchronous on macOS/Linux but async (callback-based) on Windows.
  spoof.setInterfaceMAC(iface.device, normalized, iface.port);

  if (process.platform === 'win32') {
    // Wait for registry write + netsh disable/enable to settle.
    await new Promise(r => setTimeout(r, SETTLE_MS));

    // Verify the change actually took effect.
    const updated = findPrimaryInterface();
    const actual = updated && updated.currentAddress ? normalizeMac(updated.currentAddress) : null;
    if (actual && actual.toUpperCase() !== normalized.toUpperCase()) {
      return {
        device: iface.device,
        oldMac: current,
        newMac: normalized,
        skipped: false,
        warning: `MAC unchanged after spoof (got ${actual}) — adapter may not support spoofing`,
      };
    }
  }

  return { device: iface.device, oldMac: current, newMac: normalized, skipped: false };
}

module.exports = { findPrimaryInterface, randomMac, normalizeMac, assignUniqueMac, applyMac, isAdmin };
