import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { isToolCallEventType } from "@earendil-works/pi-coding-agent";
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join, dirname, basename } from "node:path";

export const CONFIG_FILE = "fabric-routing.json";
export const ROLE_NAME_PATTERN = /^[a-z][a-z0-9_-]*$/;
const THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
const MODES = new Set(["primary", "primary-or-advisory", "subagent"]);
const RUNNERS = new Set(["pi", "claude"]);
const TRANSPORTS = new Set(["auto", "process", "tmux", "screen", "localterm"]);
const RUNNER_CHOICES = ["inherit", "pi", "claude"] as const;
const TRANSPORT_CHOICES = ["inherit", "auto", "process", "tmux", "screen", "localterm"] as const;
const EXTENSION_CHOICES = ["inherit", "enabled", "disabled"] as const;

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
export type RoleMode = "primary" | "primary-or-advisory" | "subagent";
export type RoleRunner = "pi" | "claude";
export type RoleTransport = "auto" | "process" | "tmux" | "screen" | "localterm";

/** A route keeps an open shape so fields added by Fabric or users survive edits. */
export type RoleRoute = {
  model: string;
  thinking: ThinkingLevel;
  tools: string[];
  mode: RoleMode;
  purpose?: string;
  instructions?: string;
  runner?: RoleRunner;
  transport?: RoleTransport;
  extensions?: boolean;
  [key: string]: unknown;
};

/** The same open-shape rule applies to the routing document itself. */
export type RoutingConfig = {
  roles: Record<string, RoleRoute>;
  [key: string]: unknown;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const getRoutingConfigPath = (): string =>
  join(process.env.PI_CODING_AGENT_DIR ?? join(process.env.HOME ?? "", ".pi", "agent"), CONFIG_FILE);

const invalid = (message: string): never => {
  throw new Error(message);
};

/** Validate without normalizing away unknown document or route fields. */
export const validateRoutingConfig = (value: unknown): RoutingConfig => {
  if (!isRecord(value) || !isRecord(value.roles)) {
    invalid(`Pi Fabric role routing must contain a roles object: ${getRoutingConfigPath()}`);
  }
  const document = value as Record<string, unknown>;
  const roleEntries = document.roles as Record<string, unknown>;

  const roles: Record<string, RoleRoute> = {};
  for (const [name, rawRoute] of Object.entries(roleEntries)) {
    const route = isRecord(rawRoute) ? rawRoute : invalid(`Invalid role entry: ${name}`);
    if (!ROLE_NAME_PATTERN.test(name)) invalid(`Invalid role entry: ${name}`);
    if (typeof route.model !== "string" || !/^.+\/.+$/.test(route.model)) {
      invalid(`Role ${name} requires a provider/model value`);
    }
    if (typeof route.thinking !== "string" || !THINKING_LEVELS.has(route.thinking)) {
      invalid(`Role ${name} has an invalid thinking level`);
    }
    if (!Array.isArray(route.tools) || !route.tools.every((tool) => typeof tool === "string" && tool.length > 0)) {
      invalid(`Role ${name} requires a tools array`);
    }
    if (typeof route.mode !== "string" || !MODES.has(route.mode)) {
      invalid(`Role ${name} has an invalid mode`);
    }
    if (route.purpose !== undefined && typeof route.purpose !== "string") {
      invalid(`Role ${name} has an invalid purpose`);
    }
    if (route.instructions !== undefined && typeof route.instructions !== "string") {
      invalid(`Role ${name} has invalid instructions`);
    }
    if (route.runner !== undefined && (typeof route.runner !== "string" || !RUNNERS.has(route.runner))) {
      invalid(`Role ${name} has an invalid runner`);
    }
    if (route.transport !== undefined && (typeof route.transport !== "string" || !TRANSPORTS.has(route.transport))) {
      invalid(`Role ${name} has an invalid transport`);
    }
    if (route.extensions !== undefined && typeof route.extensions !== "boolean") {
      invalid(`Role ${name} has an invalid extensions value`);
    }
    roles[name] = route as RoleRoute;
  }
  if (Object.keys(roles).length === 0) invalid("Pi Fabric role routing defines no roles");

  // Spread the original object rather than rebuilding it: unknown top-level keys
  // and unknown route fields are intentionally part of the persisted contract.
  return { ...document, roles } as RoutingConfig;
};

export const loadRoutingConfig = (): RoutingConfig => {
  const file = getRoutingConfigPath();
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`Cannot load Pi Fabric role routing from ${file}: ${reason}`);
  }
  return validateRoutingConfig(parsed);
};

/**
 * Write the complete document using a same-directory temporary file and rename.
 * Validation and serialization happen before any filesystem mutation.
 */
export const saveRoutingConfig = (value: unknown): RoutingConfig => {
  const validated = validateRoutingConfig(value);
  const file = getRoutingConfigPath();
  const directory = dirname(file);
  const content = `${JSON.stringify(validated, null, 2)}\n`;
  mkdirSync(directory, { recursive: true });

  const temporary = join(directory, `.${basename(file)}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`);
  let fd: number | undefined;
  try {
    writeFileSync(temporary, content, { encoding: "utf8", mode: 0o600 });
    if (existsSync(file)) {
      chmodSync(temporary, statSync(file).mode & 0o777);
    }
    fd = openSync(temporary, "r");
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(temporary, file);
  } catch (error) {
    if (fd !== undefined) closeSync(fd);
    if (existsSync(temporary)) unlinkSync(temporary);
    throw error;
  }
  return validated;
};

const dispatchableRoutes = (config: RoutingConfig) =>
  Object.fromEntries(
    Object.entries(config.roles).map(([name, route]) => [
      name,
      {
        model: route.model,
        thinking: route.thinking,
        tools: route.tools,
        ...(route.instructions !== undefined ? { instructions: route.instructions } : {}),
        ...(route.runner ? { runner: route.runner } : {}),
        ...(route.transport ? { transport: route.transport } : {}),
        ...(route.extensions !== undefined ? { extensions: route.extensions } : {}),
      },
    ]),
  );

/** The exact text boundary used by all role-routed calls. */
export const combineRoleInstructions = (instructions: string | undefined, task: string): string => {
  const roleText = instructions?.trim();
  const taskText = task.trim();
  if (!roleText) return task;
  if (!taskText) return roleText;
  return `${roleText}\n\nTask:\n${task}`;
};

/** Build the Fabric guest prelude. Exported to make injection behavior testable. */
export const buildRolePrelude = (config: RoutingConfig): string => {
  const routes = JSON.stringify(dispatchableRoutes(config));
  return `const __fabricRoleRoutes = ${routes} as const;
type FabricRole = keyof typeof __fabricRoleRoutes;
type FabricRoleRequest = { role: FabricRole; task: string; name?: string; timeoutMs?: number; recursive?: boolean; worktree?: boolean; schema?: Record<string, unknown> };
type FabricRoleCreateRequest = { role: FabricRole; name: string; instructions?: string; events?: Array<"input" | "turn_end" | "agent_settled" | "tool_error" | "session_compact">; topics?: string[]; delivery?: "mailbox" | "steer" | "followUp" | "nextTurn"; responseMode?: "text" | "directive"; triggerTurn?: boolean; coalesce?: boolean; timeoutMs?: number };
const __combineFabricRoleInstructions = (instructions: string | undefined, task: string) => {
  const roleText = instructions?.trim();
  const taskText = task.trim();
  if (!roleText) return task;
  if (!taskText) return roleText;
  return roleText + "\\n\\nTask:\\n" + task;
};
const __combineFabricActorInstructions = (instructions: string | undefined, actorInstructions: string | undefined, role: FabricRole) => {
  const roleText = instructions?.trim();
  const actorText = actorInstructions?.trim();
  if (!roleText && !actorText) {
    throw new Error(\`Cannot create actor for role \${String(role)}: provide non-empty central role instructions or Actor instructions.\`);
  }
  if (!roleText) return actorText;
  if (!actorText) return roleText;
  return roleText + "\\n\\nActor instructions:\\n" + actorText;
};
const __resolveFabricRole = (request: FabricRoleRequest) => {
  const { role, task, ...agentRequest } = request;
  const route = __fabricRoleRoutes[role];
  if (!route) throw new Error(\`Unknown Pi Fabric role: \${String(role)}\`);
  const { instructions, ...centralRoute } = route;
  return { ...agentRequest, task: __combineFabricRoleInstructions(instructions, task), ...centralRoute };
};
const __resolveFabricActor = (request: FabricRoleCreateRequest) => {
  const { role, instructions, ...actorRequest } = request;
  const route = __fabricRoleRoutes[role];
  if (!route) throw new Error(\`Unknown Pi Fabric role: \${String(role)}\`);
  return {
    ...actorRequest,
    instructions: __combineFabricActorInstructions(route.instructions, instructions, role),
    model: route.model,
    thinking: route.thinking,
    tools: route.tools,
    ...(route.runner ? { runner: route.runner } : {}),
    ...(route.transport ? { transport: route.transport } : {}),
  };
};
const roles = {
  run: (request: FabricRoleRequest) => agents.run(__resolveFabricRole(request)),
  spawn: (request: FabricRoleRequest) => agents.spawn(__resolveFabricRole(request)),
  create: (request: FabricRoleCreateRequest) => agents.create(__resolveFabricActor(request)),
  list: () => Object.keys(__fabricRoleRoutes) as FabricRole[],
};
`;
};

const applyPrimaryRole = async (pi: ExtensionAPI, context: ExtensionContext): Promise<void> => {
  const route = loadRoutingConfig().roles.orchestrator;
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

const toolsSummary = (tools: string[]): string => tools.length > 0 ? tools.join(", ") : "(none)";

export const formatRoleLabel = (name: string, route: RoleRoute): string =>
  `${name} — ${route.model} · thinking: ${route.thinking} · mode: ${route.mode} · tools: ${toolsSummary(route.tools)}`;

export const formatRoleDetails = (config: RoutingConfig): string =>
  Object.entries(config.roles).map(([name, route]) => {
    const optional = [
      route.runner ? `runner=${route.runner}` : undefined,
      route.transport ? `transport=${route.transport}` : undefined,
      route.extensions !== undefined ? `extensions=${route.extensions}` : undefined,
    ].filter(Boolean).join(" ");
    const purpose = route.purpose ? `\n  purpose: ${route.purpose}` : "";
    const instructions = route.instructions ? `\n  instructions: ${route.instructions}` : "";
    return `${name}\n  model: ${route.model}\n  thinking: ${route.thinking}\n  mode: ${route.mode}\n  tools: ${toolsSummary(route.tools)}${optional ? `\n  ${optional}` : ""}${purpose}${instructions}`;
  }).join("\n\n");

export const formatRoleDetail = (name: string, route: RoleRoute): string => {
  const optional = [
    route.runner ? `runner: ${route.runner}` : undefined,
    route.transport ? `transport: ${route.transport}` : undefined,
    route.extensions !== undefined ? `extensions: ${route.extensions}` : undefined,
  ].filter(Boolean).join("\n  ");
  return `${name}\n  model: ${route.model}\n  thinking: ${route.thinking}\n  mode: ${route.mode}\n  tools: ${toolsSummary(route.tools)}${optional ? `\n  ${optional}` : ""}\n  purpose: ${route.purpose?.trim() || "(none)"}\n  instructions: ${route.instructions?.trim() || "(none)"}`;
};

const notifyError = (context: ExtensionContext, error: unknown): void => {
  context.ui.notify(error instanceof Error ? error.message : String(error), "error");
};

const chooseModel = async (context: ExtensionCommandContext, current?: string): Promise<string | undefined> => {
  const available = context.modelRegistry.getAvailable();
  if (available.length === 0) {
    context.ui.notify("No available Pi models were found.", "warning");
    return undefined;
  }
  const query = await context.ui.input("Search available models", current ?? "provider/model");
  if (query === undefined) return undefined;
  const needle = query.trim().toLowerCase();
  const matches = available.filter((model) => {
    const key = `${model.provider}/${model.id}`.toLowerCase();
    return !needle || key.includes(needle) || model.name.toLowerCase().includes(needle);
  });
  if (matches.length === 0) {
    context.ui.notify(`No available models match “${query}”.`, "warning");
    return undefined;
  }
  const labels = matches.map((model) => `${model.provider}/${model.id} — ${model.name}`);
  const selected = await context.ui.select("Select model", labels);
  if (selected === undefined) return undefined;
  const index = labels.indexOf(selected);
  return index >= 0 ? `${matches[index].provider}/${matches[index].id}` : undefined;
};

export const editRole = async (
  context: ExtensionCommandContext,
  name: string,
  existing: RoleRoute,
): Promise<RoleRoute | undefined> => {
  const model = await chooseModel(context, existing.model);
  if (model === undefined) return undefined;
  const thinking = await context.ui.select("Thinking level", [...THINKING_LEVELS]) as ThinkingLevel | undefined;
  if (thinking === undefined) return undefined;
  const mode = await context.ui.select("Role mode", [...MODES]) as RoleMode | undefined;
  if (mode === undefined) return undefined;
  const toolsText = await context.ui.input("Tools (comma-separated)", existing.tools.join(", "));
  if (toolsText === undefined) return undefined;
  const purpose = await context.ui.input("Purpose (optional)", existing.purpose ?? "");
  if (purpose === undefined) return undefined;
  const instructions = await context.ui.editor("Role instructions (optional)", existing.instructions ?? "");
  if (instructions === undefined) return undefined;
  const runnerChoice = await context.ui.select("Runner", [...RUNNER_CHOICES]) as typeof RUNNER_CHOICES[number] | undefined;
  if (runnerChoice === undefined) return undefined;
  const transportChoice = await context.ui.select("Transport", [...TRANSPORT_CHOICES]) as typeof TRANSPORT_CHOICES[number] | undefined;
  if (transportChoice === undefined) return undefined;
  const extensionsChoice = await context.ui.select("Extensions", [...EXTENSION_CHOICES]) as typeof EXTENSION_CHOICES[number] | undefined;
  if (extensionsChoice === undefined) return undefined;

  const tools = [...new Set(toolsText.split(",").map((tool) => tool.trim()).filter(Boolean))];
  const edited: RoleRoute = {
    ...existing,
    model,
    thinking,
    mode,
    tools,
  };
  if (purpose.trim()) edited.purpose = purpose;
  else delete edited.purpose;
  if (instructions.trim()) edited.instructions = instructions;
  else delete edited.instructions;
  if (runnerChoice === "inherit") delete edited.runner;
  else edited.runner = runnerChoice;
  if (transportChoice === "inherit") delete edited.transport;
  else edited.transport = transportChoice;
  if (extensionsChoice === "inherit") delete edited.extensions;
  else edited.extensions = extensionsChoice === "enabled";
  return edited;
};

const addRole = async (context: ExtensionCommandContext, config: RoutingConfig): Promise<boolean> => {
  const name = await context.ui.input("New role name", "role-name");
  if (name === undefined) return false;
  if (!ROLE_NAME_PATTERN.test(name) || config.roles[name]) {
    context.ui.notify(`Role names must match ${ROLE_NAME_PATTERN.source} and be unique.`, "warning");
    return false;
  }
  const route = await editRole(context, name, {
    model: "",
    thinking: "medium",
    tools: [],
    mode: "subagent",
  });
  if (!route) return false;
  config.roles[name] = route;
  saveRoutingConfig(config);
  context.ui.notify(`Added role ${name}.`, "info");
  return true;
};

const renameRole = async (context: ExtensionCommandContext, config: RoutingConfig, oldName: string): Promise<string | undefined> => {
  const newName = await context.ui.input("Rename role", oldName);
  if (newName === undefined || newName === oldName) return undefined;
  if (!ROLE_NAME_PATTERN.test(newName) || config.roles[newName]) {
    context.ui.notify(`Role names must match ${ROLE_NAME_PATTERN.source} and be unique.`, "warning");
    return undefined;
  }
  const route = config.roles[oldName];
  delete config.roles[oldName];
  config.roles[newName] = route;
  saveRoutingConfig(config);
  context.ui.notify(`Renamed ${oldName} to ${newName}.`, "info");
  return newName;
};

const removeRole = async (context: ExtensionCommandContext, config: RoutingConfig, name: string): Promise<boolean> => {
  if (Object.keys(config.roles).length <= 1) {
    context.ui.notify("Cannot remove the last role; the routing file must contain at least one role.", "warning");
    return false;
  }
  const confirmed = await context.ui.confirm(
    `Remove role ${name}?`,
    `This permanently removes the ${name} route from ${getRoutingConfigPath()}. Continue?`,
  );
  if (!confirmed) return false;
  const nextRoles = { ...config.roles };
  delete nextRoles[name];
  saveRoutingConfig({ ...config, roles: nextRoles });
  context.ui.notify(`Removed role ${name}.`, "info");
  return true;
};

const manageRoleActions = async (
  context: ExtensionCommandContext,
  config: RoutingConfig,
  name: string,
): Promise<{ config: RoutingConfig; name?: string }> => {
  const route = config.roles[name];
  const action = await context.ui.select(formatRoleDetail(name, route), [
    "Edit",
    "Rename",
    "Remove",
    "Back",
  ]);
  if (action === undefined || action === "Back") return { config, name };
  if (action === "Edit") {
    const edited = await editRole(context, name, route);
    if (edited) {
      config.roles[name] = edited;
      saveRoutingConfig(config);
      context.ui.notify(`Updated role ${name}.`, "info");
      config = loadRoutingConfig();
    }
    return { config, name };
  }
  if (action === "Rename") {
    const renamed = await renameRole(context, config, name);
    return renamed ? { config: loadRoutingConfig(), name: renamed } : { config, name };
  }
  if (action === "Remove") {
    if (await removeRole(context, config, name)) {
      const nextConfig = loadRoutingConfig();
      return { config: nextConfig, name: Object.keys(nextConfig.roles)[0] };
    }
  }
  return { config, name };
};

const manageRoles = async (context: ExtensionCommandContext): Promise<void> => {
  let config = loadRoutingConfig();
  while (true) {
    const names = Object.keys(config.roles);
    const labels = names.map((name) => formatRoleLabel(name, config.roles[name]));
    const selected = await context.ui.select("Fabric roles", [
      ...labels,
      "Add",
      "Refresh",
      "Close",
    ]);
    if (selected === undefined || selected === "Close") return;
    const selectedIndex = labels.indexOf(selected);
    if (selectedIndex >= 0) {
      const result = await manageRoleActions(context, config, names[selectedIndex]);
      config = result.config;
      continue;
    }
    if (selected === "Refresh") {
      config = loadRoutingConfig();
      continue;
    }
    if (selected === "Add") {
      if (await addRole(context, config)) {
        config = loadRoutingConfig();
      }
    }
  }
};

const handleRoleCommand = async (args: string, context: ExtensionCommandContext): Promise<void> => {
  try {
    if (args.trim().toLowerCase() === "list" || context.mode !== "tui" || !context.hasUI) {
      context.ui.notify(formatRoleDetails(loadRoutingConfig()), "info");
      return;
    }
    await manageRoles(context);
  } catch (error) {
    notifyError(context, error);
  }
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
    event.input.code = `${buildRolePrelude(loadRoutingConfig())}\n${event.input.code}`;
  });

  pi.on("before_agent_start", (event) => {
    const routingGuidance = "Pi Fabric role routing: dispatch child work inside fabric_exec with roles.run({ role, task, ... }) or roles.spawn({ role, task, ... }). Use roles.create({ role, name, instructions? }) only when a new persistent actor is intended. Do not pass model, thinking, tools, runner, transport, or extensions at dispatch sites; the central role resolver supplies and enforces them. Role instructions are combined with the supplied task by the wrapper.";
    const additions = [routingGuidance];
    if (!process.env.PI_FABRIC_PARENT_RUN) {
      const instructions = loadRoutingConfig().roles.orchestrator?.instructions?.trim();
      if (instructions) additions.push(`Orchestrator role instructions:\n${instructions}`);
    }
    return { systemPrompt: `${event.systemPrompt}\n\n${additions.join("\n\n")}` };
  });

  pi.registerCommand("fabric-role", {
    description: "Manage centrally configured Pi Fabric roles",
    handler: handleRoleCommand,
  });
  pi.registerCommand("roles", {
    description: "Manage centrally configured Pi Fabric roles (alias)",
    handler: handleRoleCommand,
  });
}
