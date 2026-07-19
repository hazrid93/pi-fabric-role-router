import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ModuleKind, ScriptTarget, transpileModule } from "typescript";
import router, {
  buildRolePrelude,
  combineRoleInstructions,
  formatRoleCatalog,
  formatRoleDetails,
  getRoleSettingValues,
  formatRoleDetail,
  loadRoutingConfig,
  migrateRoleReferences,
  resolvePrimaryRoleName,
  saveRoutingConfig,
  validateRoutingConfig,
} from "../src/index.js";

describe("Pi Fabric role router", () => {
  const executePrelude = (config: ReturnType<typeof validateRoutingConfig>, code: string, agents: Record<string, unknown>): unknown => {
    const output = transpileModule(`${buildRolePrelude(config)}\n${code}`, {
      compilerOptions: { module: ModuleKind.None, target: ScriptTarget.ES2022 },
    }).outputText;
    return new Function("agents", output)(agents);
  };
  const originalDir = process.env.PI_CODING_AGENT_DIR;
  const originalParentRun = process.env.PI_FABRIC_PARENT_RUN;
  afterEach(() => {
    if (originalDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = originalDir;
    if (originalParentRun === undefined) delete process.env.PI_FABRIC_PARENT_RUN;
    else process.env.PI_FABRIC_PARENT_RUN = originalParentRun;
  });

  it("registers hooks and injects role wrappers into fabric_exec", () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-fabric-role-router-"));
    process.env.PI_CODING_AGENT_DIR = dir;
    writeFileSync(join(dir, "fabric-routing.json"), JSON.stringify({
      roles: {
        implement: {
          model: "example/implementer",
          thinking: "high",
          tools: ["read", "edit"],
          mode: "subagent",
          instructions: "Use the repository conventions."
        }
      }
    }));

    const hooks = new Map<string, Function>();
    const commands: string[] = [];
    const pi = {
      on(name: string, handler: Function) { hooks.set(name, handler); },
      registerCommand(name: string) { commands.push(name); }
    };
    router(pi as never);

    expect(commands).toEqual(["fabric-role", "roles"]);
    expect([...hooks.keys()]).toEqual(expect.arrayContaining(["session_start", "tool_call", "before_agent_start"]));

    const event = {
      toolName: "fabric_exec",
      input: { code: "return roles.list();" }
    };
    hooks.get("tool_call")?.(event);
    expect(event.input.code).toContain("const roles = {");
    expect(event.input.code).toContain('"model":"example/implementer"');
    expect(event.input.code).toContain('"instructions"');
    expect(event.input.code).toContain("agents.run(__resolveFabricRole(request))");
    expect(event.input.code).toContain("agents.spawn(__resolveFabricRole(request))");
    expect(event.input.code).toContain("agents.create(__resolveFabricActor(request))");
    expect(event.input.code).toContain("Actor instructions");
    expect(event.input.code).toContain("provide non-empty central role instructions or Actor instructions");
    expect(event.input.code).toContain("throw new Error");
    expect(event.input.code).toContain("return roles.list();");
    const beforeAgentStart = hooks.get("before_agent_start");
    expect(beforeAgentStart?.({ systemPrompt: "Base prompt" }).systemPrompt).toContain("Pi Fabric role routing:");
    rmSync(dir, { recursive: true, force: true });
  });

  it("reloads orchestrator instructions each turn and excludes them from Fabric children", () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-fabric-role-router-prompt-"));
    process.env.PI_CODING_AGENT_DIR = dir;
    const writeConfig = (instructions: string) => writeFileSync(join(dir, "fabric-routing.json"), JSON.stringify({
      roles: {
        orchestrator: {
          model: "example/orchestrator",
          thinking: "high",
          tools: [],
          mode: "primary",
          instructions,
        },
      },
    }));
    writeConfig("First orchestrator guidance.");
    delete process.env.PI_FABRIC_PARENT_RUN;

    const hooks = new Map<string, Function>();
    const pi = {
      on(name: string, handler: Function) { hooks.set(name, handler); },
      registerCommand() {},
    };
    router(pi as never);
    const beforeAgentStart = hooks.get("before_agent_start")!;

    const first = beforeAgentStart({ systemPrompt: "Base prompt" }).systemPrompt;
    expect(first).toContain("First orchestrator guidance.");
    expect(first).toContain("Pi Fabric role routing:");

    writeConfig("Updated orchestrator guidance.");
    const second = beforeAgentStart({ systemPrompt: "Base prompt" }).systemPrompt;
    expect(second).toContain("Updated orchestrator guidance.");
    expect(second).not.toContain("First orchestrator guidance.");

    process.env.PI_FABRIC_PARENT_RUN = "1";
    const child = beforeAgentStart({ systemPrompt: "Child prompt" }).systemPrompt;
    expect(child).toContain("Pi Fabric role routing:");
    expect(child).not.toContain("Updated orchestrator guidance.");
    rmSync(dir, { recursive: true, force: true });
  });

  it("resolves an explicit primary role, conventional fallback, or no automatic role", () => {
    const route = {
      model: "example/model",
      thinking: "medium" as const,
      tools: [],
      mode: "subagent" as const,
    };
    expect(resolvePrimaryRoleName({ roles: { plan: route }, dispatch: { primaryRole: "plan" } })).toBe("plan");
    expect(resolvePrimaryRoleName({ roles: { orchestrator: route } })).toBe("orchestrator");
    expect(resolvePrimaryRoleName({ roles: { plan: route }, dispatch: { primaryRole: "missing" } })).toBeUndefined();
    expect(resolvePrimaryRoleName({ roles: { plan: route } })).toBeUndefined();
  });

  it("migrates only router-owned rename references and preserves unknown dispatch fields", () => {
    const route = {
      model: "example/model",
      thinking: "medium" as const,
      tools: [],
      mode: "subagent" as const,
    };
    const config = validateRoutingConfig({
      dispatch: {
        primaryRole: "orchestrator",
        defaultImplementationRole: "orchestrator",
        futureDispatchField: { keep: true },
      },
      roles: { orchestrator: route, review: route },
    });
    const migration = migrateRoleReferences(config, "orchestrator", "lead");
    expect(migration.migrated).toEqual(["dispatch.primaryRole", "dispatch.defaultImplementationRole"]);
    expect(migration.config.dispatch).toEqual({
      primaryRole: "lead",
      defaultImplementationRole: "lead",
      futureDispatchField: { keep: true },
    });
    expect(migration.config.roles.lead).toBe(route);
  });

  it("materializes primaryRole when renaming the conventional fallback", () => {
    const route = {
      model: "example/model",
      thinking: "medium" as const,
      tools: [],
      mode: "primary" as const,
    };
    const migration = migrateRoleReferences(validateRoutingConfig({ roles: { orchestrator: route, review: route } }), "orchestrator", "lead");
    expect(migration.materializedPrimary).toBe(true);
    expect(migration.config.dispatch?.primaryRole).toBe("lead");
  });

  it("filters model picker items across provider, id, name, and capabilities without vision-only filtering", async () => {
    const { buildModelSelectorItems, filterModelSelectorItems } = await import("../src/model-selector.js");
    const items = buildModelSelectorItems([
      { provider: "openai", id: "text-model", name: "Text Model", reasoning: true },
      { provider: "anthropic", id: "vision-model", name: "Vision Model", input: ["text", "image"] },
    ]);
    expect(items).toHaveLength(2);
    expect(filterModelSelectorItems(items, "vision").map((item) => item.ref)).toEqual(["anthropic/vision-model"]);
    expect(filterModelSelectorItems(items, "openai").map((item) => item.ref)).toEqual(["openai/text-model"]);
    expect(items[0]?.reasoning).toBe(true);
    expect(items[1]?.image).toBe(true);
  });

  it("rejects empty actor instructions before agents.create in the generated prelude", () => {
    let createCalls = 0;
    const agents = {
      create: () => { createCalls += 1; },
      run: () => undefined,
      spawn: () => undefined,
    };
    for (const instructions of [undefined, " \t\n "]) {
      const config = validateRoutingConfig({
        roles: {
          review: {
            model: "example/reviewer",
            thinking: "low",
            tools: ["read"],
            mode: "subagent",
            ...(instructions === undefined ? {} : { instructions }),
          },
        },
      });
      expect(() => executePrelude(
        config,
        `return roles.create({ role: "review", name: "empty-actor", instructions: " \t " });`,
        agents,
      )).toThrow("Cannot create actor for role review: provide non-empty central role instructions or Actor instructions.");
    }
    expect(createCalls).toBe(0);
  });

  it("combines instructions consistently for one-shot calls and actors", () => {
    expect(combineRoleInstructions("Be concise.", "Implement it.")).toBe("Be concise.\n\nTask:\nImplement it.");
    expect(combineRoleInstructions(undefined, "Implement it.")).toBe("Implement it.");

    const config = validateRoutingConfig({
      metadata: { keep: true },
      roles: {
        implement: {
          model: "example/implementer",
          thinking: "high",
          tools: ["read"],
          mode: "subagent",
          instructions: "Follow repository conventions.",
          futureRouteField: { keep: "me" },
        },
      },
    });
    const prelude = buildRolePrelude(config);
    expect(prelude).toContain("__combineFabricRoleInstructions");
    expect(prelude).toContain("agents.run(__resolveFabricRole(request))");
    expect(prelude).toContain("agents.spawn(__resolveFabricRole(request))");
    expect(prelude).toContain("agents.create(__resolveFabricActor(request))");
    expect(prelude).toContain("Actor instructions");
    expect(prelude).toContain("provide non-empty central role instructions or Actor instructions");
    expect(prelude).toContain("Actor instructions:\\n");
    expect(prelude).toContain("Follow repository conventions.");
    expect(prelude).toContain('"model":"example/implementer"');
    expect(prelude).toContain('"tools":["read"]');
  });

  it("preserves unknown config fields and writes valid routing atomically", () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-fabric-role-router-config-"));
    process.env.PI_CODING_AGENT_DIR = dir;
    const config = {
      futureTopLevel: { enabled: true },
      roles: {
        review: {
          model: "example/reviewer",
          thinking: "low",
          tools: ["read"],
          mode: "subagent",
          futureRouteField: "preserve",
        },
      },
    };
    saveRoutingConfig(config);
    expect(loadRoutingConfig()).toEqual(config);
    expect(formatRoleDetails(loadRoutingConfig())).toContain("model: example/reviewer");
    expect(formatRoleDetail("review", loadRoutingConfig().roles.review)).toContain("purpose: (none)");
    expect(formatRoleDetail("review", loadRoutingConfig().roles.review)).toContain("instructions: (none)");
    expect(() => saveRoutingConfig({ roles: {} })).toThrow();
    expect(JSON.parse(readFileSync(join(dir, "fabric-routing.json"), "utf8"))).toEqual(config);
    rmSync(dir, { recursive: true, force: true });
  });
  it("shows all current role values and preserves tool selections", async () => {
    const route = { model: "example/current", thinking: "xhigh" as const, mode: "primary-or-advisory" as const, tools: ["read", "custom-tool"], purpose: "Analyze architecture.", instructions: "Stay read-only.", runner: "pi" as const, transport: "tmux" as const, extensions: false };
    expect(getRoleSettingValues(route)).toEqual({ model: "example/current", thinking: "xhigh", mode: "primary-or-advisory", tools: "read, custom-tool", purpose: "Analyze architecture.", instructions: "Stay read-only.", runner: "pi", transport: "tmux", extensions: "disabled" });
    const { buildToolCatalog, toggleToolSelection, moveToolSelection } = await import("../src/tool-selector.js");
    const catalog = buildToolCatalog(["custom-tool"]);
    expect(catalog).toContain("read");
    expect(catalog).toContain("custom-tool");
    expect(toggleToolSelection(["read"], "edit", catalog)).toEqual(["read", "edit"]);
    expect(toggleToolSelection(["read", "edit"], "read", catalog)).toEqual(["edit"]);
    expect(moveToolSelection(0, 3, "up")).toBe(2);
  });

  it("formats a live purpose catalog without concrete model or tool mappings", () => {
    const config = validateRoutingConfig({ dispatch: { primaryRole: "lead", defaultImplementationRole: "build" }, roles: { lead: { model: "example/lead", thinking: "high", tools: [], mode: "primary", purpose: "Coordinate work." }, build: { model: "example/build", thinking: "high", tools: ["edit"], mode: "subagent", purpose: "Implement changes." } } });
    const catalog = formatRoleCatalog(config);
    expect(catalog).toContain("lead [primary] (primary): Coordinate work.");
    expect(catalog).toContain("build [subagent] (default implementation): Implement changes.");
    expect(catalog).not.toContain("example/lead");
    expect(catalog).not.toContain("tools:");
  });

});
