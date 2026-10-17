# Working on Edit from the Windows PC

The PC runs the rewrite's porting agents (`docs/rewrite-plan.md`); the Mac stays the place
where everything is checked against real footage before it ships. Work in WSL, so the PC
behaves like Linux (Edit's macOS-only code is cfg-gated and simply isn't built there).

## One-time setup

In PowerShell (as administrator):

```powershell
wsl --install -d Ubuntu-24.04
```

Restart, open Ubuntu, then:

```bash
sudo apt update && sudo apt install -y build-essential pkg-config libssl-dev git curl unzip ffmpeg just
curl https://sh.rustup.rs -sSf | sh -s -- -y && . ~/.cargo/env
rustup target add wasm32-unknown-unknown
cargo install wasm-bindgen-cli
curl -fsSL https://bun.sh/install | bash && exec $SHELL
curl -fsSL https://claude.ai/install.sh | bash      # Claude Code, then `claude` and sign in

git config --global user.name "S-P-H-E"
git config --global user.email "sphe.g.personal@gmail.com"
ssh-keygen -t ed25519 && cat ~/.ssh/id_ed25519.pub   # add to GitHub → Settings → SSH keys

mkdir -p ~/code && cd ~/code && git clone git@github.com:spheceo/edit.git && cd edit
```

Keep the repo inside WSL (`~/code`), not under `/mnt/c`: builds there are many times slower.

## Running the work packages

Each package gets its own worktree and its own Claude Code session, so they never share a
build directory:

```bash
cd ~/code/edit && git pull
git worktree add ../edit-wp2 -b rewrite/wp2-shell origin/main
cd ../edit-wp2 && claude
```

Paste the package's prompt (below), filling in the package name. Run up to ~6 at once.
Phase 1 packages (WP2–WP8) start only after WP0 and WP1 are merged into `main`.

```
You're working on Edit. Read AGENTS.md and docs/rewrite-plan.md fully first: the plan is
the contract. You own work package <WP>, as listed in plan section 3. Build on the
foundation already on main (apps/server, crates/edit-native, packages/edit-types).
Port the package's modules, routes and MCP tools faithfully, including error text
(agents read it), with a same-named bun:test for every Rust #[test] in those modules.
Where you need another package's code that isn't ported yet, use the signatures in
apps/server/src/seams.ts. Don't start agents of your own. Run `bun run --cwd apps/server
typecheck` and `bun run --cwd apps/server test`. Commit as you go with normal messages,
no Co-authored-by or other attribution trailers, and push to branch rewrite/<wp-name>.
Finish with a short report: what's done, what isn't, and what must be checked on a Mac.
```

## Coming back to the Mac

Push the branches; on the Mac they're merged into `main`, checked with `just check`, and run
against real projects (parity harness, plan section 5).
