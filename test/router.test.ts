import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import router from "../src/index.js";

describe("Pi Fabric role router", () => {
  const originalDir = process.env.PI_CODING_AGENT_DIR;
  afterEach(() => {
    if (originalDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = originalDir;
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
          mode: "subagent"
        }
      }
    }));

    const hooks = new Map<string, Function>();
    let command = "";
    const pi = {
      on(name: string, handler: Function) { hooks.set(name, handler); },
      registerCommand(name: string) { command = name; }
    };
    router(pi as never);

    expect(command).toBe("roles");
    expect([...hooks.keys()]).toEqual(expect.arrayContaining(["session_start", "tool_call", "before_agent_start"]));

    const event = {
      toolName: "fabric_exec",
      input: { code: "return roles.list();" }
    };
    hooks.get("tool_call")?.(event);
    expect(event.input.code).toContain("const roles = {");
    expect(event.input.code).toContain('"model":"example/implementer"');
    expect(event.input.code).toContain("return roles.list();");
    rmSync(dir, { recursive: true, force: true });
  });
});