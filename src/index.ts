import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isToolCallEventType } from "@earendil-works/pi-coding-agent";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const CONFIG_FILE = "fabric-routing.json";
const THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
const MODES = new Set(["primary", "primary-or-advisory", "subagent"]);

type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
type RoleRoute = {
  model: string;
  thinking: ThinkingLevel;
  tools: string[];
  mode: "primary" | "primary-or-advisory" | "subagent";
  purpose?: string;
  runner?: "pi" | "claude";
  transport?: "auto" | "process" | "tmux" | "screen" | "localterm";
  extensions?: boolean;
};
type RoutingConfig = { roles: Record<string, RoleRoute> };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const configPath = (): string =>
  join(process.env.PI_CODING_AGENT_DIR ?? join(process.env.HOME ?? "", ".pi", "agent"), CONFIG_FILE);

const loadConfig = (): RoutingConfig => {
  const file = configPath();
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`Cannot load Pi Fabric role routing from ${file}: ${reason}`);
  }
  if (!isRecord(parsed) || !isRecord(parsed.roles)) {
    throw new Error(`Pi Fabric role routing must contain a roles object: ${file}`);
  }

  const roles: Record<string, RoleRoute> = {};
  for (const [name, value] of Object.entries(parsed.roles)) {
    if (!/^[a-z][a-z0-9_-]*$/.test(name) || !isRecord(value)) throw new Error(`Invalid role entry: ${name}`);
    if (typeof value.model !== "string" || !value.model.includes("/"))
      throw new Error(`Role ${name} requires a provider/model value`);
    if (typeof value.thinking !== "string" || !THINKING_LEVELS.has(value.thinking))
      throw new Error(`Role ${name} has an invalid thinking level`);
    if (!Array.isArray(value.tools) || !value.tools.every((tool) => typeof tool === "string" && tool.length > 0))
      throw new Error(`Role ${name} requires a tools array`);
    if (typeof value.mode !== "string" || !MODES.has(value.mode)) throw new Error(`Role ${name} has an invalid mode`);
    if (value.runner !== undefined && value.runner !== "pi" && value.runner !== "claude")
      throw new Error(`Role ${name} has an invalid runner`);
    if (value.transport !== undefined && !["auto", "process", "tmux", "screen", "localterm"].includes(String(value.transport)))
      throw new Error(`Role ${name} has an invalid transport`);
    if (value.extensions !== undefined && typeof value.extensions !== "boolean")
      throw new Error(`Role ${name} has an invalid extensions value`);
    roles[name] = value as RoleRoute;
  }
  if (Object.keys(roles).length === 0) throw new Error("Pi Fabric role routing defines no roles");
  return { roles };
};

const dispatchableRoutes = (config: RoutingConfig) =>
  Object.fromEntries(Object.entries(config.roles).map(([name, route]) => [name, {
    model: route.model,
    thinking: route.thinking,
    tools: route.tools,
    ...(route.runner ? { runner: route.runner } : {}),
    ...(route.transport ? { transport: route.transport } : {}),
    ...(route.extensions !== undefined ? { extensions: route.extensions } : {}),
  }]));

const prelude = (config: RoutingConfig): string => {
  const routes = JSON.stringify(dispatchableRoutes(config));
  return `const __fabricRoleRoutes = ${routes} as const;
type FabricRole = keyof typeof __fabricRoleRoutes;
type FabricRoleRequest = { role: FabricRole; task: string; name?: string; timeoutMs?: number; recursive?: boolean; worktree?: boolean; schema?: Record<string, unknown> };
const __resolveFabricRole = (request: FabricRoleRequest) => {
  const { role, ...agentRequest } = request;
  const route = __fabricRoleRoutes[role];
  if (!route) throw new Error(\`Unknown Pi Fabric role: \${String(role)}\`);
  return { ...agentRequest, ...route };
};
const roles = {
  run: (request: FabricRoleRequest) => agents.run(__resolveFabricRole(request)),
  spawn: (request: FabricRoleRequest) => agents.spawn(__resolveFabricRole(request)),
  list: () => Object.keys(__fabricRoleRoutes) as FabricRole[],
};
`;
};

const applyPrimaryRole = async (pi: ExtensionAPI, context: ExtensionContext): Promise<void> => {
  const route = loadConfig().roles.orchestrator;
  if (!route) return;
  const separator = route.model.indexOf("/");
  const provider = route.model.slice(0, separator);
  const id = route.model.slice(separator + 1);
  const model = context.modelRegistry.find(provider, id);
  if (!model) throw new Error(`Orchestrator role model is unavailable: ${route.model}`);
  if (context.model?.provider !== provider || context.model?.id !== id) {
    const selected = await pi.setModel(model);
    if (!selected) throw new Error(`Orchestrator role model has no available credentials: ${route.model}`);
  }
  pi.setThinkingLevel(route.thinking);
};

export default function piFabricRoleRouter(pi: ExtensionAPI): void {
  pi.on("session_start", async (_event, context) => {
    if (process.env.PI_FABRIC_PARENT_RUN) return;
    try {
      await applyPrimaryRole(pi, context);
    } catch (error) {
      context.ui.notify(error instanceof Error ? error.message : String(error), "warning");
    }
  });

  pi.on("tool_call", (event) => {
    if (!isToolCallEventType("fabric_exec", event) || typeof event.input.code !== "string") return;
    event.input.code = `${prelude(loadConfig())}\n${event.input.code}`;
  });

  pi.on("before_agent_start", (event) => ({
    systemPrompt: `${event.systemPrompt}\n\nPi Fabric role routing: dispatch child work inside fabric_exec with roles.run({ role, task, ... }) or roles.spawn({ role, task, ... }). Do not pass model, thinking, tools, runner, transport, or extensions at dispatch sites; the central role resolver supplies and enforces them.`,
  }));

  pi.registerCommand("roles", {
    description: "Show centrally configured Pi Fabric roles",
    handler: async (_args, context) => {
      try {
        const lines = Object.entries(loadConfig().roles).map(
          ([name, route]) => `${name} (${route.mode})${route.purpose ? ` — ${route.purpose}` : ""}`,
        );
        context.ui.notify(lines.join("\n"), "info");
      } catch (error) {
        context.ui.notify(error instanceof Error ? error.message : String(error), "error");
      }
    },
  });
}