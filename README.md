# claude-mods

Bryan's mods for Claude Code. Each mod lives in its own folder under `plugins/`, and `.claude-plugin/marketplace.json` lists them all, so the repository installs as one marketplace.

## Mods

| Mod | What it does |
| --- | --- |
| [bar](plugins/bar) | A color-coded context usage bar above the prompt, toggled with `/bar`. |

## Install on a machine

At the Claude Code prompt:

```
/plugin install bar --marketplace BryanCE/claude-mods
```

Or from a shell:

```
claude plugin install bar --marketplace BryanCE/claude-mods
```

Answer `y` to add the marketplace, then pick the user scope. To get newer versions later:

```
claude plugin marketplace update claude-mods
claude plugin update bar@claude-mods
```

## Develop

Point Claude Code at a mod's folder so edits reload live, in `~/.claude/settings.json`:

```json
{ "env": { "CLAUDE_CODE_PLUGIN_DIRS": "/path/to/claude-mods/plugins/bar" } }
```

Separate several folders with `:`. Check a mod with:

```
claude plugin validate plugins/bar
claude plugin test plugins/bar
```

## Add a mod

1. Make `plugins/<name>/` with its own `.claude-plugin/plugin.json`, whose `name` is `<name>`.
2. Add `{ "name": "<name>", "source": "./plugins/<name>", "description": "..." }` to `plugins` in `.claude-plugin/marketplace.json`.
3. Add a row to the table above.
