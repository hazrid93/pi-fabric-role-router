import { describe, expect, it } from "vitest";
import { ModuleKind, ScriptTarget, transpileModule } from "typescript";
import {
  buildRolePrelude,
  getRoleSettingValues,
  validateRoutingConfig,
} from "../src/index.js";

describe("persistSession support", () => {
  const executePrelude = (config: ReturnType<typeof validateRoutingConfig>, code: string, agents: Record<string, unknown>): unknown => {
    const output = transpileModule(`${buildRolePrelude(config)}\n${code}`, {
      compilerOptions: { module: ModuleKind.None, target: ScriptTarget.ES2022 },
    }).outputText;
    return new Function("agents", output)(agents);
  };

  it("validates persistSession as boolean and rejects non-boolean values", () => {
    const baseRoute = {
      model: "example/model",
      thinking: "medium" as const,
      tools: ["read"],
      mode: "subagent" as const,
    };
    // Valid: true
    expect(() => validateRoutingConfig({ roles: { ok: { ...baseRoute, runner: "claude", persistSession: true } } })).not.toThrow();
    // Valid: false
    expect(() => validateRoutingConfig({ roles: { ok: { ...baseRoute, persistSession: false } } })).not.toThrow();
    // Valid: omitted
    expect(() => validateRoutingConfig({ roles: { ok: baseRoute } })).not.toThrow();
    // Invalid: string
    expect(() => validateRoutingConfig({ roles: { bad: { ...baseRoute, persistSession: "yes" } } })).toThrow("invalid persistSession value");
    // Invalid: number
    expect(() => validateRoutingConfig({ roles: { bad: { ...baseRoute, persistSession: 1 } } })).toThrow("invalid persistSession value");
    // Invalid: null
    expect(() => validateRoutingConfig({ roles: { bad: { ...baseRoute, persistSession: null } } })).toThrow("invalid persistSession value");
    // Invalid: persistence is a Claude-only Fabric capability and must not depend on a global default.
    expect(() => validateRoutingConfig({ roles: { bad: { ...baseRoute, persistSession: true } } })).toThrow("explicitly use runner claude");
    expect(() => validateRoutingConfig({ roles: { bad: { ...baseRoute, runner: "pi", persistSession: true } } })).toThrow("explicitly use runner claude");
  });

  it("includes persistSession in dispatchable routes projection when set", () => {
    const config = validateRoutingConfig({
      roles: {
        persistent: {
          model: "claude/sonnet",
          thinking: "high",
          tools: ["read"],
          mode: "subagent",
          runner: "claude",
          persistSession: true,
        },
        ephemeral: {
          model: "claude/sonnet",
          thinking: "low",
          tools: ["read"],
          mode: "subagent",
          runner: "claude",
          persistSession: false,
        },
        inherited: {
          model: "pi/codex",
          thinking: "medium",
          tools: ["bash"],
          mode: "subagent",
        },
      },
    });
    const prelude = buildRolePrelude(config);
    // persistent role should have persistSession: true in routes
    expect(prelude).toContain('"persistSession":true');
    // ephemeral role should have persistSession: false in routes
    expect(prelude).toContain('"persistSession":false');
    // inherited role should not have persistSession key at all in dispatchable routes
    // Extract just the __fabricRoleRoutes object (before __fabricRoleDescriptions)
    const routesBlock = prelude.split('const __fabricRoleRoutes = ')[1]?.split(' as const;')[0] || '';
    const inheritedEntry = routesBlock.split('"inherited":')[1]?.split('},')[0] || '';
    expect(inheritedEntry).not.toContain('persistSession');
  });

  it("includes persistSession in describable routes projection when set", () => {
    const config = validateRoutingConfig({
      roles: {
        review: {
          model: "claude/sonnet",
          thinking: "high",
          tools: ["read"],
          mode: "subagent",
          runner: "claude",
          persistSession: true,
        },
      },
    });
    const agents = {
      run: () => undefined,
      spawn: () => undefined,
      create: () => undefined,
    };
    const result = executePrelude(config, 'return roles.describe("review");', agents);
    expect(result).toMatchObject({
      name: "review",
      persistSession: true,
    });
  });

  it("forwards persistSession from central route to agents.run/spawn", () => {
    const config = validateRoutingConfig({
      roles: {
        persistent: {
          model: "claude/sonnet",
          thinking: "high",
          tools: ["read"],
          mode: "subagent",
          runner: "claude",
          persistSession: true,
        },
        ephemeral: {
          model: "claude/sonnet",
          thinking: "low",
          tools: ["read"],
          mode: "subagent",
          runner: "claude",
          persistSession: false,
        },
      },
    });
    let lastRunRequest: Record<string, unknown> | undefined;
    let lastSpawnRequest: Record<string, unknown> | undefined;
    const agents = {
      run(request: Record<string, unknown>) { lastRunRequest = request; return request; },
      spawn(request: Record<string, unknown>) { lastSpawnRequest = request; return request; },
      create() {},
    };

    executePrelude(config, 'return roles.run({ role: "persistent", task: "work" });', agents);
    expect(lastRunRequest).toMatchObject({ persistSession: true });

    executePrelude(config, 'return roles.spawn({ role: "ephemeral", task: "work" });', agents);
    expect(lastSpawnRequest).toMatchObject({ persistSession: false });
  });

  it("forces one-shot dispatches to remain non-recursive", () => {
    const config = validateRoutingConfig({
      roles: {
        leaf: { model: "pi/model", thinking: "medium", tools: ["read"], mode: "subagent", extensions: false },
      },
    });
    let received: Record<string, unknown> | undefined;
    const agents = {
      run(request: Record<string, unknown>) { received = request; return request; },
      spawn() {},
      create() {},
    };
    executePrelude(config, 'return roles.run({ role: "leaf", task: "work", recursive: true as any });', agents);
    expect(received?.recursive).toBe(false);
  });

  it("caller cannot override central persistSession: false to true", () => {
    const config = validateRoutingConfig({
      roles: {
        locked: {
          model: "claude/sonnet",
          thinking: "high",
          tools: ["read"],
          mode: "subagent",
          runner: "claude",
          persistSession: false,
        },
      },
    });
    let received: Record<string, unknown> | undefined;
    const agents = {
      run(request: Record<string, unknown>) { received = request; return request; },
      spawn() {},
      create() {},
    };
    // Caller tries to force persistSession: true but central says false
    executePrelude(config, 'return roles.run({ role: "locked", task: "work", persistSession: true as any });', agents);
    // Central override wins — resolved after caller fields via spread order
    expect(received?.persistSession).toBe(false);
  });

  it("caller cannot override central persistSession: true to false", () => {
    const config = validateRoutingConfig({
      roles: {
        sticky: {
          model: "claude/sonnet",
          thinking: "high",
          tools: ["read"],
          mode: "subagent",
          runner: "claude",
          persistSession: true,
        },
      },
    });
    let received: Record<string, unknown> | undefined;
    const agents = {
      run(request: Record<string, unknown>) { received = request; return request; },
      spawn() {},
      create() {},
    };
    // Caller tries to force persistSession: false but central says true
    executePrelude(config, 'return roles.run({ role: "sticky", task: "work", persistSession: false as any });', agents);
    expect(received?.persistSession).toBe(true);
  });

  it("does not forward persistSession to actor creation (actors already persist)", () => {
    const config = validateRoutingConfig({
      roles: {
        monitor: {
          model: "claude/sonnet",
          thinking: "high",
          tools: ["read"],
          mode: "subagent",
          runner: "claude",
          extensions: true,
          persistSession: true,
          instructions: "Watch for issues.",
        },
      },
    });
    let received: Record<string, unknown> | undefined;
    const agents = {
      create(request: Record<string, unknown>) { received = request; return request; },
      run() {},
      spawn() {},
    };
    executePrelude(config, 'return roles.create({ role: "monitor", name: "watcher" });', agents);
    // persistSession must NOT appear in the actor request
    expect(received).toHaveProperty("name", "watcher");
    expect(received).toHaveProperty("extensions", true);
    expect(received).not.toHaveProperty("persistSession");
  });

  it("omits persistSession from dispatchable/describable projections when unset", () => {
    const config = validateRoutingConfig({
      roles: {
        plain: {
          model: "pi/codex",
          thinking: "medium",
          tools: ["bash"],
          mode: "subagent",
        },
      },
    });
    const prelude = buildRolePrelude(config);
    // The "plain" role entry in __fabricRoleRoutes should not contain persistSession
    const plainRouteMatch = prelude.match(/"plain"s*:s*{([^}]*)}/);
    expect(plainRouteMatch).not.toBeNull();
    expect(plainRouteMatch![1]).not.toContain("persistSession");

    // Same for descriptions
    const agents = {
      run() {},
      spawn() {},
      create() {},
    };
    const descResult = executePrelude(config, 'return roles.describe("plain");', agents);
    expect(descResult).not.toHaveProperty("persistSession");
  });

  it("getRoleSettingValues exposes persistSession with inherit/enabled/disabled semantics", () => {
    // When persistSession is true -> "enabled"
    const enabledRoute = {
      model: "claude/x",
      thinking: "high" as const,
      tools: [],
      mode: "subagent" as const,
      persistSession: true,
    };
    expect(getRoleSettingValues(enabledRoute).persistSession).toBe("enabled");

    // When persistSession is false -> "disabled"
    const disabledRoute = {
      model: "claude/x",
      thinking: "high" as const,
      tools: [],
      mode: "subagent" as const,
      persistSession: false,
    };
    expect(getRoleSettingValues(disabledRoute).persistSession).toBe("disabled");

    // When persistSession is omitted -> "inherit"
    const inheritedRoute = {
      model: "claude/x",
      thinking: "high" as const,
      tools: [],
      mode: "subagent" as const,
    };
    expect(getRoleSettingValues(inheritedRoute).persistSession).toBe("inherit");
  });
});
