# gaji

A lightweight CLI tool for ergonomic git worktree + tmux workflows. Create isolated git branches with dedicated working directories and tmux sessions—perfect for context-switching between tasks without losing your place.

## Installation

```bash
bun install

# Build and install the binary to ~/.local/bin
bun run build
```

Make sure `~/.local/bin` is in your PATH.

## Requirements

- [Bun](https://bun.sh) — JavaScript runtime
- Git with worktree support
- tmux

## Usage

```bash
gaji list                    # List current worktrees
gaji new <name>              # Create a new worktree from dev + branch + tmux session
gaji new <name> --run <cmd>  # Run a command in the new tmux session
gaji switch <name>           # Switch to a worktree's tmux session
gaji remove <name>           # Remove worktree, tmux session, and branch
gaji prune                   # Remove all unused worktrees
gaji merge <src> <tgt>       # Merge source branch into target worktree
```

## Commands

### `gaji new <name>`

Creates a complete development environment from the local `dev` branch:
- New git branch based on `dev`
- Linked worktree in `~/.local/share/gaji/<repo>/<name>/`
- Dedicated tmux session

Use `--run <cmd>` to start a command inside the new tmux session:

```bash
gaji new feature-auth --run "bun install && bun dev"
```

### `gaji switch <name>`

Attaches or switches to the tmux session for a worktree. Use this to hop between tasks.

### `gaji remove <name>`

Cleans up a worktree completely:
- Removes the git worktree
- Kills the tmux session
- Deletes the branch

Use `--force` to skip validation (useful for fixing partial states).

### `gaji prune`

Removes all worktrees that are:
- Missing their tmux session
- Still backed by a git worktree and branch

Use `--force` to remove dirty worktrees and force-delete their branches.

### `gaji merge <source> <target>`

Merges a source branch into a target worktree. Useful for bringing in changes without switching contexts.

## How It Works

Worktrees are stored at:
```
~/.local/share/gaji/<repo-name>/<branch-name>/
```

Each worktree gets:
- Its own working directory (isolated from your main repo)
- Its own tmux session (preserve context per task)
- Its own git branch

## Example Workflow

```bash
# Start a new feature
gaji new feature-auth

# Work on it, then start something else
gaji new bugfix-login

# Switch back to the feature
gaji switch feature-auth

# When done, merge and cleanup
gaji merge feature-auth main
gaji remove feature-auth
```

---

Created with Bun.
