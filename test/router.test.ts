import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ModuleKind, ScriptTarget, transpileModule } from "typescript";
import router, {
  buildRolePrelude,
  combineRoleInstructions,
  editRole,
  formatRoleDetails,
  formatRoleDetail,
  loadRoutingConfig,
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

  it("lets the role editor set or delete optional runner, transport, and extension fields", async () => {
    const selections = new Map<string, string>([
      ["Select model", "example/new-model — New model"],
      ["Thinking level", "high"],
      ["Role mode", "subagent"],
      ["Runner", "inherit"],
      ["Transport", "inherit"],
      ["Extensions", "inherit"],
    ]);
    const context = {
      modelRegistry: {
        getAvailable: () => [{ provider: "example", id: "new-model", name: "New model" }],
      },
      ui: {
        input: async (prompt: string) => {
          if (prompt === "Search available models") return "example/new-model";
          if (prompt === "Tools (comma-separated)") return "read, edit";
          if (prompt === "Purpose (optional)") return "";
          return undefined;
        },
        select: async (prompt: string) => selections.get(prompt),
        editor: async () => "",
      },
    };
    const edited = await editRole(context as never, "implement", {
      model: "example/old-model",
      thinking: "low",
      tools: ["read"],
      mode: "primary-or-advisory",
      purpose: "Old purpose",
      instructions: "Old instructions",
      runner: "claude",
      transport: "tmux",
      extensions: true,
      futureRouteField: "preserve",
    });

    expect(edited).toEqual({
      model: "example/new-model",
      thinking: "high",
      tools: ["read", "edit"],
      mode: "subagent",
      futureRouteField: "preserve",
    });

    selections.set("Runner", "pi");
    selections.set("Transport", "localterm");
    selections.set("Extensions", "disabled");
    const configured = await editRole(context as never, "implement", edited!);
    expect(configured?.runner).toBe("pi");
    expect(configured?.transport).toBe("localterm");
    expect(configured?.extensions).toBe(false);
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
});
