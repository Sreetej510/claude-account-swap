'use strict';

const cp = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const spoof = require('spoof');

// ── interface discovery ───────────────────────────────────────────────────────

function _primaryAdapterNameWin32() {
  const output = cp.execSync('ipconfig /all', { stdio: 'pipe', encoding: 'utf8' });
  const lines = output.split(/\r?\n/);
  let currentAdapter = null;

  for (const line of lines) {
    const adapterMatch = /^[A-Za-z].*adapter (.+?):/.exec(line);
    if (adapterMatch) { currentAdapter = adapterMatch[1]; continue; }
    if (currentAdapter) {
      const gwMatch = /Default Gateway.+?:\s*(.+)/.exec(line);
      if (gwMatch) {
        const gw = gwMatch[1].trim().replace(/\s*\(Preferred\)/, '');
        if (gw && /^[\d.a-fA-F:]+$/.test(gw)) return currentAdapter;
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
  const list = spoof.findInterfaces([]);
  return (list && list[0]) || null;
}

// ── MAC helpers ───────────────────────────────────────────────────────────────

function randomMac() { return spoof.randomize(false); }
function normalizeMac(mac) { return spoof.normalize(mac); }

function assignUniqueMac(usedMacs, currentMac) {
  const used = usedMacs.map(m => m && normalizeMac(m)).filter(Boolean);
  const norm = currentMac && normalizeMac(currentMac);
  if (norm && !used.includes(norm)) return norm;
  let candidate;
  do { candidate = randomMac(); } while (used.includes(normalizeMac(candidate)));
  return candidate;
}

// ── admin check ───────────────────────────────────────────────────────────────

function isAdmin() {
  if (process.platform !== 'win32') return process.getuid && process.getuid() === 0;
  try { cp.execSync('net session', { stdio: 'ignore' }); return true; } catch { return false; }
}

// ── Windows: synchronous persistent MAC change ────────────────────────────────
// Uses DriverDesc to find the adapter key (AdapterModel is absent on modern drivers).
// Writing NetworkAddress to HKLM persists across reboots.

function _applyMacWin32Sync(adapterName, mac) {
  const macNoColon = mac.replace(/:/g, '');

  const script = `
$name = '${adapterName.replace(/'/g, "''")}'
$mac  = '${macNoColon}'
$desc = (Get-NetAdapter -Name $name -ErrorAction Stop).InterfaceDescription
$base = 'HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Class\\{4D36E972-E325-11CE-BFC1-08002BE10318}'
$key  = Get-ChildItem $base -ErrorAction SilentlyContinue |
        Get-ItemProperty -ErrorAction SilentlyContinue |
        Where-Object { $_.DriverDesc -eq $desc } |
        Select-Object -First 1
if ($key) {
  Set-ItemProperty -Path $key.PSPath -Name NetworkAddress -Value $mac -Type String
} else {
  Write-Warning "Registry key not found for adapter: $desc"
}
netsh interface set interface $name disable | Out-Null
Start-Sleep -Milliseconds 1500
netsh interface set interface $name enable  | Out-Null
`;

  const tmp = path.join(os.tmpdir(), 'cas-mac-spoof.ps1');
  fs.writeFileSync(tmp, script, 'utf8');

  const result = cp.spawnSync(
    'powershell.exe',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', tmp],
    { encoding: 'utf8', timeout: 20000 }
  );

  try { fs.unlinkSync(tmp); } catch { /* ignore */ }

  if (result.error) throw new Error(result.error.message);
  if (result.status !== 0) throw new Error(result.stderr?.trim() || 'PowerShell failed');
}

// ── apply MAC ─────────────────────────────────────────────────────────────────

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
      device: iface.device, oldMac: current, newMac: normalized, skipped: false,
      warning: 'Run as Administrator to apply MAC spoofing',
    };
  }

  if (process.platform === 'win32') {
    // Synchronous: writes registry permanently + restarts adapter
    _applyMacWin32Sync(iface.device, normalized);
  } else {
    // macOS / Linux: spoof handles it synchronously
    spoof.setInterfaceMAC(iface.device, normalized, iface.port);
  }

  // Verify
  const updated = findPrimaryInterface();
  const actual = updated?.currentAddress ? normalizeMac(updated.currentAddress) : null;
  if (actual && actual.toUpperCase() !== normalized.toUpperCase()) {
    return {
      device: iface.device, oldMac: current, newMac: normalized, skipped: false,
      warning: `MAC still ${actual} after change — adapter may not support spoofing`,
    };
  }

  return { device: iface.device, oldMac: current, newMac: normalized, skipped: false };
}

module.exports = { findPrimaryInterface, randomMac, normalizeMac, assignUniqueMac, applyMac, isAdmin };
