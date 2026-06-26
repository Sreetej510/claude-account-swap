#!/usr/bin/env node

'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');
const readline = require('readline');

const CLAUDE_DIR = path.join(process.env.USERPROFILE || process.env.HOME, '.claude');
const CREDENTIALS_FILE = path.join(CLAUDE_DIR, '.credentials.json');
const SWAP_FILE = path.join(CLAUDE_DIR, 'swap-accounts.json');

// ── helpers ───────────────────────────────────────────────────────────────────

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8').replace(/^﻿/, ''));
  } catch {
    return null;
  }
}

function writeJson(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
}

function readSwapData() {
  return readJson(SWAP_FILE) || { currentAccount: null, accounts: [] };
}

const c = {
  reset:  '\x1b[0m',
  bold:   '\x1b[1m',
  dim:    '\x1b[2m',
  green:  '\x1b[32m',
  yellow: '\x1b[97m',
  red:    '\x1b[31m',
};

// ── interactive list selector ─────────────────────────────────────────────────

function selectFromList(items, labelFn, currentName) {
  return new Promise((resolve) => {
    if (items.length === 0) { resolve(null); return; }

    let selected = 0;
    let linesDrawn = 0;

    function clearDrawn() {
      if (linesDrawn > 0) process.stdout.write(`\x1b[${linesDrawn}A\x1b[J`);
    }

    function render() {
      clearDrawn();
      const lines = [];
      lines.push(`${c.bold}Switch Claude account${c.reset}`);
      if (currentName) lines.push(`Current: ${c.yellow}${currentName}${c.reset}`);
      lines.push(`${c.dim}↑↓ navigate  Enter select  Ctrl+C exit${c.reset}`);
      lines.push('');
      items.forEach((item, i) => {
        const label = labelFn(item);
        lines.push(i === selected ? `${c.green}❯ ${c.bold}${label}${c.reset}` : `  ${label}`);
      });
      process.stdout.write(lines.join('\n') + '\n');
      linesDrawn = lines.length;
    }

    readline.emitKeypressEvents(process.stdin);
    if (process.stdin.isTTY) process.stdin.setRawMode(true);
    render();

    function onKey(str, key) {
      if (!key) return;
      if (key.ctrl && key.name === 'c') { cleanup(); process.stdout.write('\n'); process.exit(0); }
      if (key.name === 'up')           { selected = (selected - 1 + items.length) % items.length; render(); }
      else if (key.name === 'down')    { selected = (selected + 1) % items.length; render(); }
      else if (key.name === 'return')  { cleanup(); process.stdout.write('\n'); resolve(items[selected]); }
      else if (key.name === 'escape')  { cleanup(); process.stdout.write('\n'); resolve(null); }
    }

    function cleanup() {
      if (process.stdin.isTTY) process.stdin.setRawMode(false);
      process.stdin.removeListener('keypress', onKey);
    }

    process.stdin.on('keypress', onKey);
  });
}

// ── usage fetch ───────────────────────────────────────────────────────────────

const cp = require('child_process');

function httpsGet(url, token) {
  // On Windows, Node's https is often blocked by Defender/Firewall for scripts
  // running from AppData. Use curl (built into Windows 10+) which is trusted.
  if (process.platform === 'win32') {
    return new Promise((resolve) => {
      const result = cp.spawnSync('curl', [
        '-s', '--max-time', '10',
        '-H', `Authorization: Bearer ${token}`,
        '-H', 'Accept: application/json',
        '-H', 'User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        '-w', '\n%{http_code}',
        url
      ], { encoding: 'utf8', timeout: 15000 });

      if (result.error || result.status !== 0) { resolve(null); return; }

      const out    = result.stdout.trim();
      const lines  = out.split('\n');
      const status = parseInt(lines.at(-1), 10);
      const body   = lines.slice(0, -1).join('\n');

      try { resolve({ status, data: JSON.parse(body) }); }
      catch { resolve({ status, data: null }); }
    });
  }

  // macOS / Linux: use Node's built-in https
  return new Promise((resolve) => {
    const u = new URL(url);
    const req = https.request({
      hostname: u.hostname,
      path: u.pathname + u.search,
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Accept': 'application/json',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      },
      timeout: 12000,
    }, (res) => {
      let body = '';
      res.on('data', d => body += d);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(body) }); }
        catch { resolve({ status: res.statusCode, data: null }); }
      });
    });
    req.on('error', e => resolve({ status: -1, code: e.code }));
    req.on('timeout', () => { req.destroy(); resolve({ status: -1, code: 'TIMEOUT' }); });
    req.end();
  });
}

const USAGE_CACHE_TTL = 5 * 60 * 1000;

// Returns true only when `live` credentials belong to the same account as `stored`.
// Compares organizationUuid — unique per Claude organization/personal account.
// Prevents overwriting a saved account when credentials.json has been replaced
// by a fresh login to a completely different account.
function sameAccount(stored, live) {
  if (!stored || !live) return false;
  const a = stored.organizationUuid;
  const b = live.organizationUuid;
  // If either side has no uuid (unusual), fall back to comparing token prefix
  if (!a || !b) {
    const ta = stored.claudeAiOauth?.accessToken?.slice(0, 30);
    const tb = live.claudeAiOauth?.accessToken?.slice(0, 30);
    return ta && tb && ta === tb;
  }
  return a === b;
} // 5 minutes

// Returns a human-readable usage string, or null if unavailable.
// Response shape: { five_hour: { utilization: 8.0, resets_at: "..." }, seven_day: { ... } }
// utilization is 0–100 (percent used).
async function fetchUsage(credentials, cached) {
  // Use cached value if it's fresh enough
  if (cached?.text && cached?.at && (Date.now() - cached.at) < USAGE_CACHE_TTL) {
    return cached.text;
  }

  const token = credentials?.claudeAiOauth?.accessToken;
  if (!token) return null;

  try {
    const res = await httpsGet('https://api.anthropic.com/api/oauth/usage', token);
    if (!res || res.status === -1) return `(${res?.code ?? 'unreachable'})`;
    if (res.status === 401) return '(token expired — swap to refresh)';
    if (res.status === 429) return cached?.text ?? '(rate limited)';
    if (res.status !== 200 || !res.data) return `(HTTP ${res.status})`;

    const d = res.data;

    // Enterprise: find the active allocation window with the smallest limit
    // (personal/team buckets like cinder_cove have smaller limits than org-wide)
    const NAMED_WINDOWS = ['cinder_cove', 'amber_ladder', 'tangelo', 'iguana_necktie',
                           'omelette_promotional', 'seven_day_cowork'];
    const activeWindows = NAMED_WINDOWS
      .map(k => d[k])
      .filter(w => w && w.limit_dollars != null && w.used_dollars != null)
      .sort((a, b) => a.limit_dollars - b.limit_dollars); // smallest limit first

    if (activeWindows.length > 0) {
      const w    = activeWindows[0];
      const pct  = Math.round(w.utilization ?? 0);
      const filled = Math.round(pct / 20);
      const bar  = '█'.repeat(filled) + '░'.repeat(5 - filled);
      const used = w.used_dollars.toFixed(0);
      const lim  = w.limit_dollars.toFixed(0);
      let resetStr = '';
      if (w.resets_at) {
        const rd = new Date(w.resets_at);
        resetStr = `  ↺ ${rd.toLocaleDateString([], { month: 'short', day: 'numeric' })}`;
      }
      return `${bar}${pct}% used  $${used}/$${lim}${resetStr}`;
    }

    // Fallback: org-wide monthly spend
    const eu = d.extra_usage;
    if (eu?.is_enabled && eu?.used_credits != null) {
      const currency = eu.currency ?? 'USD';
      const used     = Math.round(eu.used_credits).toLocaleString();
      const pct      = Math.round(eu.utilization ?? 0);
      const filled   = Math.round(pct / 20);
      const bar      = '█'.repeat(filled) + '░'.repeat(5 - filled);
      if (eu.monthly_limit) {
        const limit = Math.round(eu.monthly_limit).toLocaleString();
        return `${bar}${pct}% used  ${currency} ${used}/${limit}`;
      }
      return `${bar}${pct}% used  ${currency} ${used}`;
    }

    // Pro: utilization windows (percent used, 0–100)
    function fmtWindow(obj, label) {
      if (!obj || obj.utilization == null) return null;
      const used   = Math.round(obj.utilization);
      const filled = Math.round(used / 20);
      const bar    = '█'.repeat(filled) + '░'.repeat(5 - filled);
      let resetStr = '';
      if (obj.resets_at) {
        const rd = new Date(obj.resets_at);
        resetStr = `  ↺ ${rd.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
      }
      return `${label}:${bar}${used}% used${resetStr}`;
    }

    const parts = [
      fmtWindow(d.five_hour, '5h'),
      fmtWindow(d.seven_day, '7d'),
    ].filter(Boolean);

    return parts.length ? parts.join('  ') : null;
  } catch {
    return null;
  }
}

// ── commands ──────────────────────────────────────────────────────────────────

async function cmdSwap() {
  if (!readJson(CREDENTIALS_FILE)) {
    console.error(`${c.red}Error:${c.reset} No credentials found at ${CREDENTIALS_FILE}`);
    process.exit(1);
  }

  const swapData = readSwapData();

  if (swapData.accounts.length === 0) {
    console.log('No accounts saved yet.\n');
    console.log(`Save the current credentials first:\n  ${c.bold}cas add "My Account"${c.reset}`);
    process.exit(0);
  }

  const available = swapData.accounts.filter(a => a.name !== swapData.currentAccount);

  if (available.length === 0) {
    console.log(`Only one account saved (${c.yellow}${swapData.currentAccount}${c.reset}) — nothing to swap to.`);
    console.log(`Add another account:\n  ${c.bold}cas add "Another Account"${c.reset}`);
    process.exit(0);
  }

  const selected = await selectFromList(
    available,
    (a) => {
      const sub = a.credentials?.claudeAiOauth?.subscriptionType;
      return sub ? `${a.name}  ${c.dim}${sub}${c.reset}` : a.name;
    },
    swapData.currentAccount
  );

  if (!selected) { console.log('Cancelled.'); return; }

  // Re-read now — tokens may have refreshed while the picker was open
  const currentCreds = readJson(CREDENTIALS_FILE);

  // Save current (refreshed) credentials back before switching.
  // Guard: only overwrite if credentials.json still belongs to the same account
  // (user may have logged out and back in as someone else since last swap).
  if (swapData.currentAccount) {
    const idx = swapData.accounts.findIndex(a => a.name === swapData.currentAccount);
    if (idx >= 0 && sameAccount(swapData.accounts[idx].credentials, currentCreds)) {
      swapData.accounts[idx].credentials = currentCreds;
    }
  }

  swapData.currentAccount = selected.name;
  writeJson(SWAP_FILE, swapData);
  writeJson(CREDENTIALS_FILE, selected.credentials);

  console.log(`${c.green}✓${c.reset} Switched to ${c.bold}${selected.name}${c.reset}`);
  console.log(`${c.dim}Restart Claude Code for the change to take effect.${c.reset}`);
}

async function cmdAdd(name) {
  if (!name) { console.error(`Usage: cas add <name>`); process.exit(1); }

  const currentCreds = readJson(CREDENTIALS_FILE);
  if (!currentCreds) {
    console.error(`${c.red}Error:${c.reset} No credentials found at ${CREDENTIALS_FILE}`);
    process.exit(1);
  }

  const swapData = readSwapData();
  const existingIdx = swapData.accounts.findIndex(a => a.name === name);

  if (existingIdx >= 0) {
    swapData.accounts[existingIdx].credentials = currentCreds;
    console.log(`${c.green}✓${c.reset} Updated account ${c.bold}${name}${c.reset}`);
  } else {
    swapData.accounts.push({ name, credentials: currentCreds });
    console.log(`${c.green}✓${c.reset} Added account ${c.bold}${name}${c.reset}`);
  }

  // The credentials in credentials.json belong to this account right now,
  // so it's always the current account after an add.
  swapData.currentAccount = name;

  writeJson(SWAP_FILE, swapData);
  console.log(`${c.dim}Saved to ${SWAP_FILE}${c.reset}`);
}

async function cmdList() {
  const swapData = readSwapData();

  if (swapData.accounts.length === 0) {
    console.log(`No accounts saved.\n  ${c.bold}cas add "Name"${c.reset} to save the current credentials.`);
    return;
  }

  // Keep active account's stored token in sync with the live credentials.json
  // (Claude Code refreshes tokens silently, so the stored copy goes stale fast).
  // Guard: only sync if credentials.json still belongs to the same account —
  // if the user logged out and back in as someone else, don't clobber the stored creds.
  const liveCreds = readJson(CREDENTIALS_FILE);
  if (liveCreds && swapData.currentAccount) {
    const idx = swapData.accounts.findIndex(a => a.name === swapData.currentAccount);
    if (idx >= 0 && sameAccount(swapData.accounts[idx].credentials, liveCreds)) {
      swapData.accounts[idx].credentials = liveCreds;
      writeJson(SWAP_FILE, swapData);
    }
  }

  console.log(`${c.bold}Saved accounts:${c.reset}\n`);
  process.stdout.write(`${c.dim}Fetching usage…${c.reset}\r`);

  // Fetch usage for all accounts in parallel, passing any cached value
  const usages = await Promise.all(
    swapData.accounts.map(a => fetchUsage(a.credentials, a.usageCache))
  );

  // Persist fresh values back (only real usage data, not error strings)
  const isErrorMsg = t => !t || t.startsWith('(');
  let cacheDirty = false;
  usages.forEach((text, i) => {
    const a = swapData.accounts[i];
    if (!isErrorMsg(text) && text !== a.usageCache?.text) {
      a.usageCache = { text, at: Date.now() };
      cacheDirty = true;
    }
  });
  if (cacheDirty) writeJson(SWAP_FILE, swapData);

  process.stdout.write('\r\x1b[K'); // clear "Fetching…" line

  swapData.accounts.forEach((a, i) => {
    const active  = a.name === swapData.currentAccount;
    const sub     = a.credentials?.claudeAiOauth?.subscriptionType || 'unknown';
    const usage   = usages[i];
    const marker  = active ? `${c.green}●${c.reset}` : ' ';
    const activeTag = active ? `  ${c.green}(active)${c.reset}` : '';
    const usageTag  = usage  ? `  ${c.yellow}${usage}${c.reset}` : '';
    console.log(`  ${marker} ${c.bold}${a.name}${c.reset}  ${c.dim}${sub}${c.reset}${usageTag}${activeTag}`);
  });
  console.log();
}

function cmdRemove(name) {
  if (!name) { console.error(`Usage: cas remove <name>`); process.exit(1); }

  const swapData = readSwapData();
  const idx = swapData.accounts.findIndex(a => a.name === name);

  if (idx < 0) { console.error(`${c.red}Error:${c.reset} Account not found: ${name}`); process.exit(1); }
  if (swapData.currentAccount === name) {
    console.error(`${c.red}Error:${c.reset} Cannot remove the active account. Switch to another first.`);
    process.exit(1);
  }

  swapData.accounts.splice(idx, 1);
  writeJson(SWAP_FILE, swapData);
  console.log(`${c.green}✓${c.reset} Removed account ${c.bold}${name}${c.reset}`);
}

function showHelp() {
  console.log(`
${c.bold}claude-account-swap${c.reset} — Switch between Claude accounts

${c.bold}Usage:${c.reset}
  cas                     Interactive account switcher
  cas add <name>          Save current credentials as a named account
  cas list                List all saved accounts
  cas remove <name>       Remove a saved account
  cas help                Show this help

${c.bold}Typical workflow:${c.reset}
  1. Log in to account A in Claude Code
     ${c.dim}cas add "Work"${c.reset}
  2. Log in to account B in Claude Code
     ${c.dim}cas add "Personal"${c.reset}
  3. Run ${c.bold}cas${c.reset} any time to switch between them

${c.bold}Files:${c.reset}
  Active credentials : ${CREDENTIALS_FILE}
  Saved accounts     : ${SWAP_FILE}
`);
}

// ── entry ─────────────────────────────────────────────────────────────────────

async function main() {
  const [,, cmd, ...args] = process.argv;
  const arg = args.join(' ').trim();

  switch (cmd) {
    case 'add':    await cmdAdd(arg); break;
    case 'list':   await cmdList(); break;
    case 'remove': cmdRemove(arg); break;
    case 'help':
    case '--help':
    case '-h':     showHelp(); break;
    case undefined: await cmdSwap(); break;
    default:
      console.error(`${c.red}Unknown command:${c.reset} ${cmd}`);
      showHelp();
      process.exit(1);
  }
}

main().then(() => process.exit(0)).catch(err => {
  console.error(`${c.red}Error:${c.reset}`, err.message);
  process.exit(1);
});
