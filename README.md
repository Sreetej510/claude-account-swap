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

```sh
cas list
```

Lists all saved accounts with live usage data — quota bars for Pro accounts and dollar spend for Enterprise accounts.

## Commands

| Command | Description |
|---|---|
| `cas` | Interactive account switcher |
| `cas add <name>` | Save current credentials as a named account |
| `cas list` | List all saved accounts with usage |
| `cas remove <name>` | Delete a saved account |
| `cas help` | Show help |

All commands also work with `claude-account-swap` as the prefix.

## Usage display

`cas list` fetches live usage from the Anthropic API and shows:

- **Pro accounts** — 5-hour and 7-day quota bars with reset times (e.g. `5h:██░░░32% used  ↺ 1:50 pm`)
- **Enterprise accounts** — team allocation bar with dollar spend and reset date (e.g. `███░░67% used  $669/$1000  ↺ 7 Sept`)

Usage is cached for 5 minutes to avoid rate limiting.

## Files

| Path | Purpose |
|---|---|
| `~/.claude/.credentials.json` | Active Claude credentials (managed by Claude Code) |
| `~/.claude/swap-accounts.json` | All saved accounts and usage cache |

## License

MIT
