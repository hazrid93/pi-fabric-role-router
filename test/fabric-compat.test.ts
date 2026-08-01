import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ModuleKind, ScriptTarget, transpileModule } from "typescript";
import { describe, expect, it } from "vitest";
import { buildRolePrelude, validateRoutingConfig } from "../src/index.js";

type FabricTypeCheckResult = {
  errors: Array<{ message: string }>;
  javascript?: string;
};

type FabricGuestTypesModule = {
  GUEST_TYPE_DECLARATIONS: string;
};

type FabricTypeCheckerModule = {
  typeCheckFabricCode: (code: string, declarations: string) => FabricTypeCheckResult;
};

const loadInstalledFabricTypeSurface = async (): Promise<{
  declarations: string;
  typeCheck: FabricTypeCheckerModule["typeCheckFabricCode"];
}> => {
  const fabricDistDirectory = dirname(fileURLToPath(import.meta.resolve("pi-fabric")));
  const guestTypesUrl = pathToFileURL(join(fabricDistDirectory, "runtime", "guest-types.js")).href;
  const typeCheckerUrl = pathToFileURL(join(fabricDistDirectory, "runtime", "type-checker.js")).href;
  const [guestTypes, typeChecker] = await Promise.all([
    import(/* @vite-ignore */ guestTypesUrl) as Promise<FabricGuestTypesModule>,
    import(/* @vite-ignore */ typeCheckerUrl) as Promise<FabricTypeCheckerModule>,
  ]);
  return {
    declarations: guestTypes.GUEST_TYPE_DECLARATIONS,
    typeCheck: typeChecker.typeCheckFabricCode,
  };
};

const compatibilityConfig = () => validateRoutingConfig({
  roles: {
    review: {
      model: "anthropic/claude-sonnet-4-5",
      thinking: "high",
      tools: ["read", "grep"],
      mode: "subagent",
      instructions: "Review without editing.",
      runner: "pi",
      transport: "herdr",
      extensions: false,
    },
  },
});

describe("installed Pi Fabric compatibility", () => {
  it("type-checks every role wrapper against Fabric's installed guest declarations", async () => {
    const { declarations, typeCheck } = await loadInstalledFabricTypeSurface();
    expect(declarations).toContain('"herdr"');
    expect(declarations).toMatch(/interface FabricActorRequestBase[\s\S]*extensions\?: boolean;[\s\S]*validWhile\?: FabricActorValidWhile;/);

    const source = `${buildRolePrelude(compatibilityConfig())}
const spawned = roles.spawn({ role: "review", task: "Review the patch.", worktree: true });
const completed = roles.run({ role: "review", task: "Review the tests.", schema: { type: "object" } });
const actor = roles.create({
  role: "review",
  name: "review-watcher",
  events: ["before_provider_request", "tool_execution_end"],
  delivery: "steer",
  triggerTurn: true,
  validWhile: (facts) => ({ valid: facts.current.idle, reason: "host must be idle" }),
});
return { spawned: await spawned, completed: await completed, actor: await actor, roles: roles.list(), review: roles.describe("review") };`;
    const result = typeCheck(source, declarations);

    expect(result.errors).toEqual([]);
    expect(result.javascript).toBeTruthy();
  });

  it("forwards centrally enforced current transport and extension policy to actors", () => {
    const source = `${buildRolePrelude(compatibilityConfig())}
return roles.create({ role: "review", name: "review-watcher" });`;
    const javascript = transpileModule(source, {
      compilerOptions: { module: ModuleKind.None, target: ScriptTarget.ES2022 },
    }).outputText;
    let received: Record<string, unknown> | undefined;
    const agents = {
      create(request: Record<string, unknown>) {
        received = request;
        return request;
      },
    };

    new Function("agents", javascript)(agents);

    expect(received).toMatchObject({
      name: "review-watcher",
      transport: "herdr",
      extensions: false,
      instructions: "Review without editing.",
    });
  });
});