# pi-fabric-role-router

A community-maintained Pi extension for centralized, role-based routing in [Pi Fabric](https://github.com/monotykamary/pi-fabric).

Instead of repeating concrete model IDs, thinking levels, and tool permissions in prompts and Fabric programs, define them once in `~/.pi/agent/fabric-routing.json` and dispatch by role:

```ts
const result = await roles.run({
  role: "implement",
  task: "Implement the requested change and run focused tests."
});
return result;
```

> This project integrates with and requires Pi Fabric. It is not affiliated with or endorsed by the maintainers of Pi or Pi Fabric.

## Why

Native Pi Fabric agent calls accept concrete routing settings through `agents.run()` and `agents.spawn()`. This extension adds a small policy layer:

- `roles.run({ role, task })`
- `roles.spawn({ role, task })`
- `roles.list()`
- `/roles` in the Pi TUI
- automatic top-level assignment from the conventional `orchestrator` role
- one central source of truth for model, thinking, tools, runner, transport, and extension policy
- dispatch-site enforcement: centrally managed fields cannot be overridden by callers

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

Create the routing configuration:

```bash
cp ~/.pi/agent/git/github.com/hazrid93/pi-fabric-role-router/examples/fabric-routing.json \
  ~/.pi/agent/fabric-routing.json
```

Depending on Pi's package checkout layout/version, locate the example with:

```bash
find ~/.pi/agent -path '*pi-fabric-role-router/examples/fabric-routing.json'
```

Then edit every placeholder model:

```bash
$EDITOR ~/.pi/agent/fabric-routing.json
```

Reload Pi with `/reload` or start a fresh process.

## Configuration

The central file is:

```text
~/.pi/agent/fabric-routing.json
```

Minimal example:

```json
{
  "roles": {
    "orchestrator": {
      "model": "provider/planning-model",
      "thinking": "high",
      "tools": [],
      "mode": "primary"
    },
    "implement": {
      "model": "provider/implementation-model",
      "thinking": "xhigh",
      "tools": ["read", "grep", "find", "ls", "edit", "write", "bash"],
      "mode": "subagent",
      "extensions": true
    }
  }
}
```

Each role supports:

| Field | Required | Meaning |
|---|---:|---|
| `model` | yes | Pi model as `provider/model` |
| `thinking` | yes | `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max` |
| `tools` | yes | Exact tool allowlist for the Fabric child |
| `mode` | yes | Descriptive policy metadata: `primary`, `primary-or-advisory`, or `subagent` |
| `purpose` | no | Human-readable text shown by `/roles` |
| `runner` | no | Pi Fabric runner: `pi` or `claude` |
| `transport` | no | Pi Fabric child transport |
| `extensions` | no | Whether the child loads Pi extensions |

The file is re-read on every `fabric_exec` call, so dispatch changes do not require rebuilding the extension.

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

Inspect names:

```ts
return roles.list();
```

In Pi's TUI:

```text
/roles
```

Do not provide central fields at a dispatch site. The wrapper intentionally resolves them after caller fields, preventing override:

```ts
// Keep dispatches role-based; configure these fields centrally instead.
roles.run({ role: "implement", task: "..." });
```

## Orchestrator behavior

If a role named `orchestrator` exists, the extension selects its `model` and `thinking` for a top-level Pi session at startup. Pi Fabric child processes are excluded so their selected role is preserved.

`mode: "primary"` is descriptive; the conventional role name `orchestrator` triggers top-level selection.

## How it works

Pi loads both extensions. When `fabric_exec` is called, this extension injects typed `roles` wrappers into the type-checked Fabric program. Those wrappers resolve the requested role and call Pi Fabric's native `agents.run()` or `agents.spawn()` API.

Pi Fabric remains the agent runtime; this project supplies centralized role routing on top.

## Development

```bash
npm install
npm run check
pi -e ./dist/index.js
```

## Related projects

- [monotykamary/pi-fabric](https://github.com/monotykamary/pi-fabric) — the programmable tool and agent runtime this extension integrates with
- [badlogic/pi-mono](https://github.com/badlogic/pi-mono) — upstream Pi coding agent project
- [ryan-brosas/fabric-pi-template](https://github.com/ryan-brosas/fabric-pi-template) — role-oriented Pi Fabric configuration inspiration

## License

MIT