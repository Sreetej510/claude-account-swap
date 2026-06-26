# claude-account-swap

Switch between multiple Claude accounts from the terminal. Swaps the credentials file and spoofs your MAC address so each account looks like a distinct device.

## Install

```sh
npm install -g claude-account-swap
```

> MAC spoofing requires the terminal to be run as **Administrator** (Windows) or with **sudo** (macOS/Linux).

## Setup

Log in to your first account in Claude Code, then save it:

```sh
claude-swap add "Personal"
```

Log in to your second account, then save it:

```sh
claude-swap add "Work"
```

Each account gets a unique MAC address automatically. The first account keeps your real MAC; additional accounts get randomly generated VM-vendor MACs so they appear as different devices.

## Usage

```sh
claude-swap
```

Opens an interactive picker. Use arrow keys to select an account, Enter to switch. The tool:

1. Writes the selected account's credentials to `~/.claude/.credentials.json`
2. Spoofs your network adapter's MAC to the address stored for that account
3. Saves your current credentials back before switching

Restart Claude Code after swapping.

## Commands

| Command | Description |
|---|---|
| `claude-swap` | Interactive account switcher |
| `claude-swap add <name>` | Save current credentials + MAC as a named account |
| `claude-swap list` | List all saved accounts with their MACs |
| `claude-swap remove <name>` | Delete a saved account |
| `claude-swap help` | Show help |

## Files

| Path | Purpose |
|---|---|
| `~/.claude/.credentials.json` | Active Claude credentials (managed by Claude Code) |
| `~/.claude/swap-accounts.json` | All saved accounts with credentials and MACs |

## Notes

- **Admin required for MAC spoofing.** Credentials still swap without it — only the MAC step is skipped.
- The network adapter disconnects for ~5 seconds when the MAC changes.
- Accounts are stored locally; nothing is sent anywhere.

## License

MIT
