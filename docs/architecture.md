# pi-fabric-role-router — Architecture

> A Pi Fabric extension that adds OMP-style role routing: named roles defined once in `~/.pi/agent/fabric-routing.json`, dispatched with `roles.run()` / `roles.spawn()` / `roles.create()`, and enforced centrally so dispatch sites cannot override model, thinking, tools, runner, transport, extensions, recursion, or session persistence.

| | |
|---|---|
| **Language** | TypeScript · ES Modules |
| **Runtime** | Node.js 24+ · in-process under Pi (requires Pi Fabric 0.21.10+; `persistSession` requires the adjacent feature checkout) |
| **Config** | `~/.pi/agent/fabric-routing.json` (auto-generated on first run, mode `0600`) |
| **Entry points** | `fabric_exec` role wrappers · `/fabric-roles` manager · `before_agent_start` primary assignment |
| **Delegation** | Pi Fabric `agents.run()` · `agents.spawn()` · `agents.create()` |

---

## High-Level Architecture

```mermaid
flowchart TB
  subgraph Host["Pi host process"]
    ORCH["Primary session<br/>(orchestrator)"]
    FE["fabric_exec tool call"]
  end

  subgraph Ext["pi-fabric-role-router extension  (src)"]
    IDX["index.ts<br/>extension entry"]
    CFG["config bootstrap<br/>fabric-routing.json<br/>(auto-generate · 0600)"]
    RESOLVER["role resolver<br/>resolveFabricRole / resolveFabricActor"]
    ROLES["typed roles wrappers<br/>roles.run · roles.spawn ·<br/>roles.create · roles.list · roles.describe"]
    UI["/fabric-roles manager<br/>model-selector.ts · tool-selector.ts"]
  end

  subgraph Fabric["Pi Fabric"]
    AGENTS["agents.run / agents.spawn / agents.create"]
  end

  subgraph Children["Fabric child agents"]
    W1["worker · role model,<br/>thinking, tools, instructions"]
    W2["worker · role model,<br/>thinking, tools, instructions"]
  end

  subgraph Config["~/.pi/agent/fabric-routing.json"]
    RJ["roles: model · enabled · thinking ·<br/>tools · mode · purpose · instructions ·<br/>runner · transport · extensions · persistSession<br/>dispatch: primaryRole ·<br/>defaultImplementationRole"]
  end

  IDX --> CFG
  IDX --> UI
  UI --> RJ
  CFG -.reads each turn.-> RJ
  ORCH -->|"before_agent_start:<br/>live role catalog + primary<br/>model/thinking + instructions"| IDX
  FE --> ROLES
  ROLES --> RESOLVER
  RESOLVER -.central fields override caller.-> RJ
  ROLES --> AGENTS
  AGENTS --> W1
  AGENTS --> W2
```

---

## Dispatch Flow — `roles.run()`

```mermaid
sequenceDiagram
  participant O as Orchestrator
  participant X as fabric_exec
  participant R as roles.run wrapper
  participant C as Role resolver
  participant F as Pi Fabric agents.run

  O->>X: roles.run({ role: "implement", task })
  X->>R: inject typed roles into checked program
  R->>C: resolve role "implement"
  C->>C: read fabric-routing.json<br/>caller fields first, central fields last
  C->>F: model · thinking · tools · runner ·<br/>transport · extensions · persistSession enforced<br/>recursive dispatch disabled
  R->>R: role instructions + "Task:" + task
  F-->>R: child agent result
  R-->>O: result
```

Disabled roles are absent from `roles.list()` and dispatch lookup — a disabled route stays stored and editable but cannot be dispatched until re-enabled.

---

## Startup Bootstrap — First-Run Config Generation

```mermaid
flowchart TB
  START["Pi session starts"] --> CHECK{"~/.pi/agent/<br/>fabric-routing.json exists?"}
  START -->|"no current model"| NOWARN["no file written ·<br/>warning with /fabric-roles hint"]
  CHECK -->|"yes"| KEEP["leave untouched — never overwritten or merged"]
  CHECK -->|no| EX["load bundled<br/>examples/fabric-routing.json"]
  EX --> SUB["replace every placeholder model<br/>with host current model (provider/id)"]
  SUB --> WRITE["write with mode 0600<br/>(atomic · race resolved quietly)"]
  WRITE --> NOTIFY["Pi notifies once with path<br/>+ /fabric-roles suggestion"]
  NOTIFY --> QUIET["reload · resume · new sessions stay quiet"]
```

---

## Per-Turn Primary Assignment

```mermaid
flowchart LR
  A["session_start"] --> B["load fabric-routing.json"]
  B --> C["dispatch.primaryRole set?<br/>(fallback: existing 'orchestrator')"]
  C -->|yes| D["apply primary role model + thinking<br/>for this session"]
  C -->|no| F["no automatic primary assignment"]
  H["before_agent_start"] --> I["re-read fabric-routing.json"]
  I --> E["append current primary instructions<br/>to system prompt"]
  E --> G["inject live role catalog:<br/>enabled names · modes · purposes"]
```

The routing file is reloaded on every prompt hook and Fabric dispatch, so instruction and catalog edits take effect on the next turn without reloading the extension. Primary model and thinking changes apply at the next session start. Renaming a role migrates `dispatch.primaryRole` and `dispatch.defaultImplementationRole` references automatically.

---

## Precedence — Central Policy Wins

```mermaid
flowchart LR
  A["caller fields"] --> B["resolveFabricRole"]
  C["central role fields"] --> B
  B --> D["central fields applied after caller fields —<br/>model, thinking, tools, runner,<br/>transport, extensions, persistSession cannot be<br/>overridden; recursive dispatch is disabled"]
```
