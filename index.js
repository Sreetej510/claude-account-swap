#!/usr/bin/env node

'use strict';

const fs = require('fs');
const path = require('path');
const readline = require('readline');

const CLAUDE_DIR = path.join(process.env.USERPROFILE || process.env.HOME, '.claude');
const CREDENTIALS_FILE = path.join(CLAUDE_DIR, '.credentials.json');
const SWAP_FILE = path.join(CLAUDE_DIR, 'swap-accounts.json');

// ── helpers ───────────────────────────────────────────────────────────────────

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
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
  yellow: '\x1b[33m',
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

  // Save current (refreshed) credentials back before switching
  if (swapData.currentAccount) {
    const idx = swapData.accounts.findIndex(a => a.name === swapData.currentAccount);
    if (idx >= 0) swapData.accounts[idx].credentials = currentCreds;
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

  if (!swapData.currentAccount) swapData.currentAccount = name;

  writeJson(SWAP_FILE, swapData);
  console.log(`${c.dim}Saved to ${SWAP_FILE}${c.reset}`);
}

function cmdList() {
  const swapData = readSwapData();

  if (swapData.accounts.length === 0) {
    console.log(`No accounts saved.\n  ${c.bold}cas add "Name"${c.reset} to save the current credentials.`);
    return;
  }

  console.log(`${c.bold}Saved accounts:${c.reset}\n`);
  swapData.accounts.forEach(a => {
    const active = a.name === swapData.currentAccount;
    const sub    = a.credentials?.claudeAiOauth?.subscriptionType || 'unknown';
    const marker = active ? `${c.green}●${c.reset}` : ' ';
    const tag    = active ? `  ${c.green}(active)${c.reset}` : '';
    console.log(`  ${marker} ${c.bold}${a.name}${c.reset}  ${c.dim}${sub}${c.reset}${tag}`);
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
    case 'list':   cmdList(); break;
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
