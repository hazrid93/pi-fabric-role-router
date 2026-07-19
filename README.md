# pi-fabric-role-router

A community-maintained Pi extension for centralized, role-based routing in [Pi Fabric](https://github.com/monotykamary/pi-fabric).

Define model, thinking, tools, and role guidance once in `~/.pi/agent/fabric-routing.json`, then dispatch by role:

```ts
return await roles.run({
  role: "implement",
  task: "Add input validation and run the focused test suite."
});
```

> This project integrates with and requires Pi Fabric. It is not affiliated with or endorsed by the maintainers of Pi or Pi Fabric.

## What it provides

- `roles.run({ role, task })` and `roles.spawn({ role, task })` with centrally enforced model, thinking, tools, runner, transport, and extension policy.
- `roles.create({ role, name, instructions? })` for an optional new persistent Fabric actor with centrally enforced model, thinking, and tools.
- `roles.list()` for enabled, dispatchable role names; disabled stored roles remain inspectable with `roles.describe()`.
- `/fabric-roles` for the interactive role manager and detailed text-mode mappings.
- Optional role `purpose` and `instructions`; instructions are combined before the caller's task or actor instructions.
- Configurable automatic top-level assignment through `dispatch.primaryRole`, with the conventional `orchestrator` fallback.

## Requirements

- Node.js 24+
- Pi 0.80.6+
- [Pi Fabric](https://github.com/monotykamary/pi-fabric) 0.21.10+

## Install

Install Pi Fabric first, then this extension from GitHub:

```bash
pi install npm:pi-fabric
pi install git:github.com/hazrid93/pi-fabric-role-router
```

The routing configuration is generated automatically on first run. When Pi starts a session and `~/.pi/agent/fabric-routing.json` does not exist, this extension loads its bundled `examples/fabric-routing.json`, replaces every placeholder model with the host's current model (`provider/id`), and writes the result with mode `0600`. The generated config is immediately valid on any provider, every role starts from the current model, and the primary orchestrator receives safe default delegation and verification guidance. An existing file is never overwritten or merged; if another process creates it during startup, the race is resolved quietly and the winner's file is kept. When the file is created, Pi notifies once with the path and a suggestion to manage roles with `/fabric-roles`; reload, resume, and new sessions stay quiet. If no current model is available at startup, no file is written and a warning explains how to proceed, including the `/fabric-roles` command to use after initialization.

Do **not** copy or replace `~/.pi/agent/AGENTS.md` when installing this extension. Global and project `AGENTS.md` files remain user-owned and continue to supply environment- or repository-specific instructions. The generated primary role's editable `instructions` provide the reusable orchestration policy and compose with those existing instructions. Existing `fabric-routing.json` files are left unchanged; review or customize the primary policy with `/fabric-roles > orchestrator > Edit` (or edit whichever role is configured as `dispatch.primaryRole`).

The role manager's canonical command is `/fabric-roles` (plural) for both interactive and text list modes; no legacy command aliases are registered.

Refine per-role model, thinking, tools, and guidance interactively:

```text
/fabric-roles
/fabric-roles list
```

The top-level picker lists every stored role—including disabled roles marked clearly—plus Add, Refresh, and Close. Selecting a role opens its detail/action submenu with its current Enabled state, model, thinking, mode, tools, purpose, instructions, runner, transport, and extensions, plus Edit, Rename, Enable/Disable, and Back. Enable/Disable always asks for confirmation. Disabling is non-destructive: the route remains stored, editable, and renameable, but disappears from the live catalog and cannot be dispatched until enabled again. Editing opens a stateful settings screen that immediately shows every current value. Model uses a searchable Vision Handoff-style picker; thinking and mode use current-value choice menus; tools use a checklist with the current allowlist preselected (`read`, `grep`, `find`, `ls`, `edit`, `write`, `bash`, plus existing custom tools); purpose and optional multi-line instructions use prefilled editors. Runner, transport, and extension settings also show their current or inherited value. Changes remain staged until **Save**, and **Cancel** discards them. Purpose and instructions are editable under `/fabric-roles > role > Edit`: purpose tells the primary orchestrator when to choose a role, while instructions govern the dispatched worker and are prepended to its task. Selecting `inherit` removes an optional field from the saved route rather than writing a sentinel value.

Reload Pi with `/reload` or start a fresh process after installing or changing extension code. The routing file is read each turn for Fabric dispatch and top-level prompt preparation, so configuration edits take effect without rebuilding the extension.

<details>
<summary>Manual recovery (optional)</summary>

If automatic generation is unavailable (for example, no model is selected at startup), create the file by hand from the shipped example and edit the placeholder models:

```bash
cp ~/.pi/agent/git/github.com/hazrid93/pi-fabric-role-router/examples/fabric-routing.json \
  ~/.pi/agent/fabric-routing.json
$EDITOR ~/.pi/agent/fabric-routing.json
```

Depending on Pi's package checkout layout/version, locate the example with:

```bash
find ~/.pi/agent -path '*pi-fabric-role-router/examples/fabric-routing.json'
```

</details>

## Configuration

The central file is:

```text
~/.pi/agent/fabric-routing.json
```

The complete ready-to-copy configuration, including concrete model mappings, is in [`examples/fabric-routing.json`](examples/fabric-routing.json). Keep provider/model mappings in that routing JSON rather than in behavior Markdown or role instructions.

Each role supports:

| Field | Required | Meaning |
|---|---:|---|
| `model` | yes | Pi model as `provider/model` |
| `enabled` | no | Whether the role is dispatchable; omitted defaults to `true`. Disabled roles remain stored for temporary, non-destructive hiding. |
| `thinking` | yes | `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max` |
| `tools` | yes | Exact tool allowlist for the Fabric child |
| `mode` | yes | Descriptive policy metadata: `primary`, `primary-or-advisory`, or `subagent` |
| `purpose` | no | Editable display metadata shown by the manager and text listing; it does not affect runtime |
| `instructions` | no | Editable runtime guidance prepended to a one-shot task or actor instructions |
| `runner` | no | Optional Pi Fabric runner: `pi` or `claude`; omit to inherit the Fabric default |
| `transport` | no | Optional child transport: `auto`, `process`, `tmux`, `screen`, or `localterm`; omit to inherit |
| `extensions` | no | Optional child extension policy: `true` to enable or `false` to disable; omit to inherit |

The optional `dispatch` object controls router-owned internal references:

| Field | Meaning |
|---|---|
| `primaryRole` | Role used for automatic top-level startup model/thinking and primary instructions. If omitted, `orchestrator` is used only when that conventional role exists. |
| `defaultImplementationRole` | Router-owned default implementation role reference preserved and migrated by role rename; it does not itself trigger startup assignment. |

Unknown top-level configuration keys and unknown route fields are preserved by the manager. Writes are validated before an atomic same-directory replacement.

## Usage in Pi Fabric

Run one role:

```ts
return await roles.run({
  role: "implement",
  task: "Add input validation and run the focused test suite."
});
```

Spawn roles concurrently:

```ts
const implementation = roles.spawn({
  role: "implement",
  task: "Implement the bounded backend change."
});

const review = roles.spawn({
  role: "review",
  task: "Review the existing design without editing files."
});

return await Promise.all([implementation, review]);
```

Create an optional persistent actor:

```ts
const actor = await roles.create({
  role: "review",
  name: "review-watcher",
  instructions: "Watch for regressions and report actionable findings."
});
```

For `run` and `spawn`, the configured role instructions are followed by a `Task:` separator and the supplied task. For `create`, configured role instructions are followed by the optional `Actor instructions:` supplied at the call site. Actor creation rejects the request before `agents.create` if both sources are missing or whitespace-only. Empty guidance is otherwise omitted. The wrapper resolves central fields after caller fields, so callers cannot override model, thinking, tools, runner, transport, or extensions for one-shot dispatches; actor creation centrally sets model, thinking, tools, runner, and transport (extensions are not an actor setting in Fabric's actor API).

Inspect names:

```ts
return roles.list();
```

Do not provide central fields at a dispatch site:

```ts
// Keep dispatches role-based; configure these fields centrally instead.
roles.run({ role: "implement", task: "..." });
```

## Actor compatibility

No actor is required to use this extension. `roles.run` and `roles.spawn` create one-shot agents only; they do not create or modify persistent actors. Existing Fabric actors retain their own settings and are untouched. Only `roles.create` routes a newly created actor through a role. Global actor imports remain managed by Pi Fabric. This extension does not change Fabric's actor lifecycle, persistence, mailbox behavior, or global actor registry.

## Primary role behavior

Set `dispatch.primaryRole` to the role whose `model` and `thinking` should be selected for a top-level Pi session at startup. Its optional `instructions` are appended to the top-level Pi `before_agent_start` system prompt on every turn. If `dispatch.primaryRole` is absent and `orchestrator` exists, `orchestrator` remains the conventional fallback. If neither is available, no automatic primary assignment occurs. `mode: "primary"` is descriptive and does not select a role by itself.

The routing file is reloaded for each prompt hook and Fabric dispatch, so edits apply on the next turn. A live catalog containing only enabled role names, modes, and purposes is injected into the primary session each turn; newly added, renamed, enabled, or disabled roles therefore update routing immediately without editing Markdown, while disabled roles stay out of the orchestrator's catalog. Disabled roles remain available to `roles.describe()` for management and discovery, but `roles.list()` and dispatch lookup expose enabled names only. Renaming migrates the internal `dispatch.primaryRole` and `dispatch.defaultImplementationRole` references when they point at the renamed role. Renaming the fallback `orchestrator` materializes `dispatch.primaryRole` to preserve automatic startup. External dispatches and prompts cannot be rewritten; update those callers to use the new role name. A primary role or default implementation role must be changed before that role can be disabled, preserving configuration integrity.

## How it works

Pi loads both extensions. When `fabric_exec` is called, this extension injects typed `roles` wrappers into the type-checked Fabric program. Those wrappers resolve the requested role and call Pi Fabric's native `agents.run()`, `agents.spawn()`, or optional `agents.create()` API.

Pi Fabric remains the agent runtime; this project supplies centralized role routing and role-management UI on top. Existing Fabric actors and global imports remain Fabric-managed.

## Development

```bash
npm install
npm run check
npm pack --dry-run
pi -e ./src/index.ts
```

## Related projects

- [monotykamary/pi-fabric](https://github.com/monotykamary/pi-fabric) — the programmable tool and agent runtime this extension integrates with
- [badlogic/pi-mono](https://github.com/badlogic/pi-coding-agent) — upstream Pi coding agent project
- [ryan-brosas/fabric-pi-template](https://github.com/ryan-brosas/fabric-pi-template) — role-oriented Pi Fabric configuration inspiration

## License

MIT
