# claude-account-swap

Switch between multiple Claude accounts from the terminal by swapping the credentials file.

## Install

```sh
npm install -g claude-account-swap
```

## Setup

Log in to your first account in Claude Code, then save it:

```sh
cas add "Personal"
```

Log in to your second account, then save it:

```sh
cas add "Work"
```

## Usage

```sh
cas
```

Opens an interactive picker. Use arrow keys to select an account, press Enter to switch. Restarts Claude Code to apply the change.

## Commands

| Command | Description |
|---|---|
| `cas` | Interactive account switcher |
| `cas add <name>` | Save current credentials as a named account |
| `cas list` | List all saved accounts |
| `cas remove <name>` | Delete a saved account |
| `cas help` | Show help |

All commands also work with `claude-account-swap` as the prefix.

## Files

| Path | Purpose |
|---|---|
| `~/.claude/.credentials.json` | Active Claude credentials (managed by Claude Code) |
| `~/.claude/swap-accounts.json` | All saved accounts |

## License

MIT
