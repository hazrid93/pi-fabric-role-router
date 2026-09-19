import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readFileSync } from "node:fs";
import { ModuleKind, ScriptTarget, transpileModule } from "typescript";
import router, {
  hasRole,
  buildRolePrelude,
  resolvePrimaryRoleName,
  validateRoutingConfig,
} from "../src/index.js";

const exec = (config: ReturnType<typeof validateRoutingConfig>, code: string, agents: Record<string, unknown>) => {
  const js = transpileModule(`${buildRolePrelude(config)}\n${code}`, {
    compilerOptions: { module: ModuleKind.None, target: ScriptTarget.ES2022 },
  }).outputText;
  return new Function("agents", js)(agents);
};

/** A role that INHERITS runner/transport/extensions rather than declaring them. */
const inheriting = () => validateRoutingConfig({
  roles: {
    review: { model: "a/b", thinking: "high", tools: ["read"], mode: "subagent" },
  },
});

const originalDir = process.env.PI_CODING_AGENT_DIR;
afterEach(() => {
  if (originalDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = originalDir;
});

describe("central policy cannot be overridden at the dispatch site", () => {
  it("strips runner/transport/extensions the role inherits rather than declares", () => {
    let got: Record<string, unknown> | undefined;
    const agents = { run: (r: Record<string, unknown>) => { got = r; return r; } };
    exec(inheriting(),
      `return roles.run({ role: "review", task: "t", runner: "claude", transport: "tmux", extensions: true } as any);`,
      agents);
    expect(got).not.toHaveProperty("runner");
    expect(got).not.toHaveProperty("transport");
    expect(got).not.toHaveProperty("extensions");
  });

  it("still strips them when the caller spreads them from a variable", () => {
    let got: Record<string, unknown> | undefined;
    const agents = { run: (r: Record<string, unknown>) => { got = r; return r; } };
    exec(inheriting(),
      `const extra = { role: "review" as const, task: "t", runner: "claude" };\nreturn roles.run(extra as any);`,
      agents);
    expect(got).not.toHaveProperty("runner");
  });

  it("strips caller model/thinking/tools too", () => {
    let got: Record<string, unknown> | undefined;
    const agents = { run: (r: Record<string, unknown>) => { got = r; return r; } };
    exec(inheriting(),
      `return roles.run({ role: "review", task: "t", model: "evil/m", thinking: "off", tools: ["bash"] } as any);`,
      agents);
    expect(got).toMatchObject({ model: "a/b", thinking: "high", tools: ["read"] });
  });

  it("keeps a declared value and still ignores the caller's", () => {
    const declared = validateRoutingConfig({
      roles: { review: { model: "a/b", thinking: "high", tools: [], mode: "subagent", runner: "pi" } },
    });
    let got: Record<string, unknown> | undefined;
    const agents = { run: (r: Record<string, unknown>) => { got = r; return r; } };
    exec(declared, `return roles.run({ role: "review", task: "t", runner: "claude" } as any);`, agents);
    expect(got).toMatchObject({ runner: "pi" });
  });

  it("strips inherited fields for actors as well", () => {
    let got: Record<string, unknown> | undefined;
    const agents = { create: (r: Record<string, unknown>) => { got = r; return r; } };
    exec(inheriting(),
      `return roles.create({ role: "review", name: "w", instructions: "i", transport: "tmux" } as any);`,
      agents);
    expect(got).not.toHaveProperty("transport");
    expect(got).toMatchObject({ name: "w", model: "a/b" });
  });
});

describe("inherited Object.prototype keys are not roles", () => {
  it("hasRole rejects an inherited key", () => {
    expect(hasRole({ review: 1 }, "review")).toBe(true);
    expect(hasRole({ review: 1 }, "constructor")).toBe(false);
  });

  it("dispatch to `constructor` is rejected, not silently policy-free", () => {
    const agents = { run: () => { throw new Error("A WORKER WAS LAUNCHED"); } };
    expect(() => exec(inheriting(),
      `return roles.run({ role: "constructor", task: "t", model: "evil/m", tools: ["bash"] } as any);`,
      agents)).toThrow(/Unknown Pi Fabric role: constructor/);
  });

  it("actor creation on `constructor` is rejected", () => {
    const agents = { create: () => { throw new Error("AN ACTOR WAS CREATED"); } };
    expect(() => exec(inheriting(),
      `return roles.create({ role: "constructor", name: "w", instructions: "i" } as any);`,
      agents)).toThrow(/Unknown Pi Fabric role: constructor/);
  });

  it("describe on `constructor` is rejected", () => {
    expect(() => exec(inheriting(), `return roles.describe("constructor" as any);`, {}))
      .toThrow(/Unknown Pi Fabric role: constructor/);
  });

  it("a dispatch reference to a nonexistent `constructor` does not resolve as primary", () => {
    const config = validateRoutingConfig({
      dispatch: { primaryRole: "constructor" },
      roles: { review: { model: "a/b", thinking: "high", tools: [], mode: "subagent" } },
    });
    expect(resolvePrimaryRoleName(config)).toBeUndefined();
  });

  it("a role genuinely NAMED constructor still works", () => {
    const config = validateRoutingConfig({
      dispatch: { primaryRole: "constructor" },
      roles: { constructor: { model: "a/b", thinking: "high", tools: [], mode: "primary" } },
    });
    expect(resolvePrimaryRoleName(config)).toBe("constructor");
    let got: Record<string, unknown> | undefined;
    exec(config, `return roles.run({ role: "constructor", task: "t" } as any);`,
      { run: (r: Record<string, unknown>) => { got = r; return r; } });
    expect(got).toMatchObject({ model: "a/b" });
  });
});

describe("a broken routing file does not kill the turn", () => {
  const install = (contents?: string) => {
    const dir = mkdtempSync(join(tmpdir(), "pi-fabric-role-router-hard-"));
    process.env.PI_CODING_AGENT_DIR = dir;
    if (contents !== undefined) writeFileSync(join(dir, "fabric-routing.json"), contents);
    return dir;
  };
  const hooks: Record<string, Function> = {};
  const pi = { on: (n: string, h: Function) => { hooks[n] = h; }, registerCommand: () => {} } as never;

  it("before_agent_start degrades instead of throwing when the config is missing", () => {
    const dir = install();
    router(pi);
    const out = hooks.before_agent_start({ systemPrompt: "SP" }) as { systemPrompt: string };
    expect(out.systemPrompt).toContain("SP");
    expect(out.systemPrompt).toContain("Pi Fabric role routing");
    expect(out.systemPrompt).not.toContain("live routing catalog");
    rmSync(dir, { recursive: true, force: true });
  });

  it("before_agent_start degrades instead of throwing on corrupt JSON", () => {
    const dir = install("{ not json");
    router(pi);
    expect(() => hooks.before_agent_start({ systemPrompt: "SP" })).not.toThrow();
    rmSync(dir, { recursive: true, force: true });
  });

  it("tool_call leaves the program unmodified instead of throwing", () => {
    const dir = install("{ not json");
    router(pi);
    const event = { toolName: "fabric_exec", input: { code: "return 1;" } };
    expect(() => hooks.tool_call(event)).not.toThrow();
    expect(event.input.code).toBe("return 1;");
    rmSync(dir, { recursive: true, force: true });
  });

  it("tool_call still injects the prelude when the config is valid", () => {
    const dir = install(JSON.stringify({
      roles: { review: { model: "a/b", thinking: "high", tools: [], mode: "subagent" } },
    }));
    router(pi);
    const event = { toolName: "fabric_exec", input: { code: "return 1;" } };
    hooks.tool_call(event);
    expect(event.input.code).toContain("const roles =");
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("packaging", () => {
  it("runs the full check before publishing so dist/ cannot be omitted", () => {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    expect(pkg.scripts.prepublishOnly).toBeTruthy();
    expect(pkg.files).toContain("dist/");
  });
});
