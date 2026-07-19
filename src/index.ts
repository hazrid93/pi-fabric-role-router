import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  Theme,
} from "@earendil-works/pi-coding-agent";
import {
  getSelectListTheme,
  getSettingsListTheme,
  isToolCallEventType,
} from "@earendil-works/pi-coding-agent";
import { ModelSelectorComponent } from "./model-selector.js";
import {
  buildToolCatalog,
  ToolSelectorComponent,
  uniqueToolNames,
} from "./tool-selector.js";
import {
  Container,
  type Component,
  type SettingItem,
  type TUI,
  SettingsList,
  Editor,
  Input,
  Key,
  matchesKey,
  Text,
  getKeybindings,
  truncateToWidth,
  SelectList,
  type SelectListTheme,
} from "@earendil-works/pi-tui";
import {
  chmodSync,
  closeSync,
  existsSync,
  fchmodSync,
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
import { fileURLToPath } from "node:url";

export const CONFIG_FILE = "fabric-routing.json";
export const ROLE_NAME_PATTERN = /^[a-z][a-z0-9_-]*$/;
const THINKING_LEVEL_CHOICES = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
const THINKING_LEVELS: ReadonlySet<string> = new Set(THINKING_LEVEL_CHOICES);
const MODE_CHOICES = ["primary", "primary-or-advisory", "subagent"] as const;
const MODES: ReadonlySet<string> = new Set(MODE_CHOICES);
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
export type DispatchConfig = {
  primaryRole?: string;
  defaultImplementationRole?: string;
  [key: string]: unknown;
};

export type RoutingConfig = {
  roles: Record<string, RoleRoute>;
  dispatch?: DispatchConfig;
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

  if (document.dispatch !== undefined && !isRecord(document.dispatch)) {
    invalid("Pi Fabric role routing dispatch must be an object");
  }
  if (isRecord(document.dispatch)) {
    if (document.dispatch.primaryRole !== undefined && typeof document.dispatch.primaryRole !== "string") {
      invalid("Pi Fabric role routing dispatch.primaryRole must be a string");
    }
    if (document.dispatch.defaultImplementationRole !== undefined && typeof document.dispatch.defaultImplementationRole !== "string") {
      invalid("Pi Fabric role routing dispatch.defaultImplementationRole must be a string");
    }
  }
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

/** Resolve the role that owns automatic top-level model and prompt behavior. */
export const resolvePrimaryRoleName = (config: RoutingConfig): string | undefined => {
  const configured = config.dispatch?.primaryRole;
  if (configured !== undefined) return config.roles[configured] ? configured : undefined;
  return config.roles.orchestrator ? "orchestrator" : undefined;
};

export type RoleReferenceMigration = {
  config: RoutingConfig;
  migrated: string[];
  materializedPrimary: boolean;
};

/** Rename a role and migrate only the router-owned dispatch references. */
export const migrateRoleReferences = (
  config: RoutingConfig,
  oldName: string,
  newName: string,
): RoleReferenceMigration => {
  const nextConfig = { ...config, roles: { ...config.roles } };
  const nextDispatch = config.dispatch ? { ...config.dispatch } : {};
  const migrated: string[] = [];
  let materializedPrimary = false;
  if (nextDispatch.primaryRole === oldName) {
    nextDispatch.primaryRole = newName;
    migrated.push("dispatch.primaryRole");
  } else if (oldName === "orchestrator" && nextDispatch.primaryRole === undefined) {
    nextDispatch.primaryRole = newName;
    materializedPrimary = true;
  }
  if (nextDispatch.defaultImplementationRole === oldName) {
    nextDispatch.defaultImplementationRole = newName;
    migrated.push("dispatch.defaultImplementationRole");
  }
  if (Object.keys(nextDispatch).length > 0 || config.dispatch) nextConfig.dispatch = nextDispatch;
  const route = nextConfig.roles[oldName];
  delete nextConfig.roles[oldName];
  nextConfig.roles[newName] = route;
  return { config: nextConfig, migrated, materializedPrimary };
};

export const removeRoleReferences = (config: RoutingConfig, name: string): string[] => {
  const references: string[] = [];
  if (config.dispatch?.primaryRole === name) references.push("dispatch.primaryRole");
  if (config.dispatch?.defaultImplementationRole === name) references.push("dispatch.defaultImplementationRole");
  if (references.length > 0 && config.dispatch) {
    const dispatch = { ...config.dispatch };
    if (dispatch.primaryRole === name) delete dispatch.primaryRole;
    if (dispatch.defaultImplementationRole === name) delete dispatch.defaultImplementationRole;
    config.dispatch = dispatch;
  }
  return references;
};

/** Actionable guidance shown when the routing file is missing. */
export const missingConfigMessage = (file: string): string =>
  `Pi Fabric role routing is not configured: ${file} is missing. Start a new Pi session to generate it automatically from the current model, or create it manually (see the package README).`;

export const loadRoutingConfig = (): RoutingConfig => {
  const file = getRoutingConfigPath();
  if (!existsSync(file)) throw new Error(missingConfigMessage(file));
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

const reasonOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

const isExistsError = (error: unknown): boolean =>
  typeof error === "object" && error !== null && (error as NodeJS.ErrnoException).code === "EEXIST";

/** Format a model reference in the provider/id form used by routing config. */
export const formatModelRef = (provider: string, id: string): string => `${provider}/${id}`;

/**
 * Replace every role's placeholder model in the bundled template with the
 * given model ref, preserving all other fields and role distinctions. Pure:
 * validates the result without touching the filesystem.
 */
export const seedTemplateModels = (template: unknown, modelRef: string): RoutingConfig => {
  const document = isRecord(template) ? template : invalid("Pi Fabric role routing template must contain a roles object");
  const roleEntries = isRecord(document.roles) ? document.roles : invalid("Pi Fabric role routing template must contain a roles object");
  const roles: Record<string, unknown> = {};
  for (const [name, rawRoute] of Object.entries(roleEntries)) {
    const route = isRecord(rawRoute) ? rawRoute : invalid(`Invalid role entry in template: ${name}`);
    roles[name] = { ...route, model: modelRef };
  }
  return validateRoutingConfig({ ...document, roles });
};

let bundledExamplePathOverride: string | undefined;

/** Override the bundled example path (tests/advanced recovery). */
export const setBundledExamplePath = (path: string | undefined): void => {
  bundledExamplePathOverride = path;
};

/**
 * Resolve the bundled example routing template shipped with the package.
 * Computed relative to this module so it works both when Pi loads src/index.ts
 * (examples is ../examples) and when running the built dist/index.js (examples
 * is still ../examples). Derived from the module URL rather than CWD or argv
 * to avoid import.meta path fragility.
 */
export const getBundledExamplePath = (): string => {
  if (bundledExamplePathOverride) return bundledExamplePathOverride;
  const here = fileURLToPath(import.meta.url);
  return join(dirname(here), "..", "examples", CONFIG_FILE);
};

export type BootstrapOutcome =
  | { created: true; path: string }
  | { created: false; reason: "exists"; path: string }
  | { created: false; reason: "template"; error: string }
  | { created: false; reason: "write"; error: string };

/**
 * First-run routing config installation. Reads and seeds the bundled template
 * with the current model ref, then race-safely exclusive-creates the target
 * file with mode 0600. Never overwrites or merges an existing file; another
 * process winning the race is reported as "exists", not an error. Template and
 * filesystem errors never leave a partial or broken config behind.
 */
export const bootstrapRoutingConfig = (options: {
  modelRef: string;
  templatePath?: string;
  templateContent?: string;
  targetPath?: string;
}): BootstrapOutcome => {
  const target = options.targetPath ?? getRoutingConfigPath();
  // Fast path: avoid reading and validating the template when the config
  // already exists. Race safety comes from the exclusive open below.
  if (existsSync(target)) return { created: false, reason: "exists", path: target };

  const templatePath = options.templatePath ?? getBundledExamplePath();
  let templateText: string;
  try {
    templateText =
      options.templateContent !== undefined ? options.templateContent : readFileSync(templatePath, "utf8");
  } catch (error) {
    return { created: false, reason: "template", error: `Cannot read bundled routing template ${templatePath}: ${reasonOf(error)}` };
  }

  let parsedTemplate: unknown;
  try {
    parsedTemplate = JSON.parse(templateText);
  } catch (error) {
    return { created: false, reason: "template", error: `Bundled routing template is not valid JSON (${templatePath}): ${reasonOf(error)}` };
  }

  let config: RoutingConfig;
  try {
    config = seedTemplateModels(parsedTemplate, options.modelRef);
  } catch (error) {
    return { created: false, reason: "template", error: `Bundled routing template is invalid: ${reasonOf(error)}` };
  }

  const directory = dirname(target);
  try {
    mkdirSync(directory, { recursive: true });
  } catch (error) {
    return { created: false, reason: "write", error: `Cannot create routing config directory ${directory}: ${reasonOf(error)}` };
  }

  const content = `${JSON.stringify(config, null, 2)}\n`;
  let fd: number | undefined;
  try {
    // O_CREAT | O_EXCL: fails with EEXIST if another process created the file
    // between the existsSync check above and here. Mode 0600 has no group/other
    // bits, so umask cannot relax it; fchmod re-asserts it on the open fd.
    fd = openSync(target, "wx", 0o600);
    fchmodSync(fd, 0o600);
    writeFileSync(fd, content, "utf8");
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
  } catch (error) {
    if (fd !== undefined) {
      // We created the file; a later step failed. Remove our partial file.
      try { closeSync(fd); } catch { /* ignore close error during cleanup */ }
      try { unlinkSync(target); } catch { /* another process may have removed it */ }
      return { created: false, reason: "write", error: `Cannot create routing config ${target}: ${reasonOf(error)}` };
    }
    if (isExistsError(error)) return { created: false, reason: "exists", path: target };
    return { created: false, reason: "write", error: `Cannot create routing config ${target}: ${reasonOf(error)}` };
  }
  return { created: true, path: target };
};

export type EnsureOutcome =
  | { created: true; path: string; modelRef: string }
  | { created: false; reason: "exists"; path: string }
  | { created: false; reason: "no-model" }
  | { created: false; reason: "template"; error: string }
  | { created: false; reason: "write"; error: string };

/**
 * Bootstrap the routing config from the host's current model. Returns a
 * structured outcome so session_start can notify exactly once on creation and
 * stay quiet when the config already exists. Refuses to write when no current
 * model is available so a broken config is never created.
 */
export const ensureRoutingConfig = (
  context: Pick<ExtensionContext, "model">,
  options?: { templatePath?: string; templateContent?: string; targetPath?: string },
): EnsureOutcome => {
  const model = context.model;
  if (!model || typeof model.provider !== "string" || typeof model.id !== "string") {
    return { created: false, reason: "no-model" };
  }
  const modelRef = formatModelRef(model.provider, model.id);
  const outcome = bootstrapRoutingConfig({ modelRef, ...options });
  if (outcome.created) return { created: true, path: outcome.path, modelRef };
  if (outcome.reason === "exists") return { created: false, reason: "exists", path: outcome.path };
  return { created: false, reason: outcome.reason, error: outcome.error };
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

/** Whitelist role metadata exposed by roles.describe; unknown route fields stay private. */
const describableRoutes = (config: RoutingConfig) =>
  Object.fromEntries(
    Object.entries(config.roles).map(([name, route]) => [
      name,
      {
        name,
        model: route.model,
        thinking: route.thinking,
        tools: route.tools,
        mode: route.mode,
        ...(route.purpose !== undefined ? { purpose: route.purpose } : {}),
        ...(route.instructions !== undefined ? { instructions: route.instructions } : {}),
        ...(route.runner !== undefined ? { runner: route.runner } : {}),
        ...(route.transport !== undefined ? { transport: route.transport } : {}),
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
  const descriptions = JSON.stringify(describableRoutes(config));
  return `const __fabricRoleRoutes = ${routes} as const;
const __fabricRoleDescriptions = ${descriptions} as const;
type FabricRole = keyof typeof __fabricRoleRoutes;
type FabricRoleDescription = { name: string; model: string; thinking: string; tools: readonly string[]; mode: string; purpose?: string; instructions?: string; runner?: string; transport?: string; extensions?: boolean };
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
  describe: (role: FabricRole): FabricRoleDescription => {
    const description = __fabricRoleDescriptions[role];
    if (!description) throw new Error(\`Unknown Pi Fabric role: \${String(role)}\`);
    return { ...description };
  },
};
`;
};

export const applyPrimaryRole = async (pi: ExtensionAPI, context: ExtensionContext): Promise<void> => {
  const config = loadRoutingConfig();
  const primaryName = resolvePrimaryRoleName(config);
  if (!primaryName) return;
  const route = config.roles[primaryName];
  const separator = route.model.indexOf("/");
  const provider = route.model.slice(0, separator);
  const id = route.model.slice(separator + 1);
  const model = context.modelRegistry.find(provider, id);
  if (!model) throw new Error(`Primary role ${primaryName} model is unavailable: ${route.model}`);
  if (context.model?.provider !== provider || context.model?.id !== id) {
    const selected = await pi.setModel(model);
    if (!selected) throw new Error(`Primary role ${primaryName} model has no available credentials: ${route.model}`);
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

export const formatRoleCatalog = (config: RoutingConfig): string => {
  const primary = resolvePrimaryRoleName(config);
  const implementation = config.dispatch?.defaultImplementationRole;
  const lines = Object.entries(config.roles).map(([name, route]) => {
    const markers = [
      name === primary ? "primary" : undefined,
      name === implementation ? "default implementation" : undefined,
    ].filter(Boolean);
    const purpose = route.purpose?.trim() || `Configured ${route.mode} role.`;
    return `- ${name} [${route.mode}]${markers.length ? ` (${markers.join(", ")})` : ""}: ${purpose}`;
  });
  return `Available Pi Fabric roles (live routing catalog):\n${lines.join("\n")}\nChoose roles by purpose and dispatch with roles.run({ role, task }).`;
};

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

const optionalChoice = <T extends string>(value: T | undefined): string => value ?? "inherit";
const extensionChoice = (value: boolean | undefined): typeof EXTENSION_CHOICES[number] =>
  value === undefined ? "inherit" : value ? "enabled" : "disabled";
const toolsDisplayValue = (tools: readonly string[]): string => tools.length > 0 ? tools.join(", ") : "(none)";

/** A small SelectList submenu that starts on the route's current value. */
class RoleChoicePicker implements Component {
  private readonly list: SelectList;
  private readonly title: string;

  constructor(
    title: string,
    values: readonly string[],
    currentValue: string,
    theme: SelectListTheme,
    done: (value: string | undefined) => void,
  ) {
    this.title = title;
    this.list = new SelectList(
      values.map((value) => ({ value, label: value, description: value === currentValue ? "Current value" : undefined })),
      Math.min(values.length, 10),
      theme,
    );
    this.list.setSelectedIndex(Math.max(0, values.findIndex((value) => value === currentValue)));
    this.list.onSelect = (item) => done(item.value);
    this.list.onCancel = () => done(undefined);
  }

  render(width: number): string[] {
    return [this.title, "", ...this.list.render(width)];
  }

  handleInput(data: string): void {
    this.list.handleInput(data);
  }

  invalidate(): void {
    this.list.invalidate();
  }
}

const makeTextEditor = (
  tui: TUI,
  theme: Theme,
  currentValue: string,
  multiline: boolean,
  done: (value: string | undefined) => void,
): Component => {
  if (multiline) {
    const editor = new Editor(tui, {
      borderColor: (text) => theme.fg("border", text),
      selectList: getSelectListTheme(),
    });
    editor.setText(currentValue);
    editor.focused = true;
    editor.onSubmit = (value) => done(value);
    return {
      render: (width) => editor.render(width),
      handleInput: (data) => {
        if (matchesKey(data, Key.escape)) done(undefined);
        else editor.handleInput(data);
      },
      invalidate: () => editor.invalidate(),
    };
  }
  const input = new Input();
  input.setValue(currentValue);
  input.focused = true;
  input.onSubmit = (value) => done(value);
  input.onEscape = () => done(undefined);
  return {
    render: (width) => [theme.fg("accent", multiline ? "Edit instructions" : "Edit purpose"), "", ...input.render(width)],
    handleInput: (data) => input.handleInput(data),
    invalidate: () => input.invalidate(),
  };
};

export type RoleSettingValues = {
  model: string;
  thinking: string;
  mode: string;
  tools: string;
  purpose: string;
  instructions: string;
  runner: string;
  transport: string;
  extensions: string;
};

/** Values displayed immediately by the stateful settings screen. */
export const getRoleSettingValues = (route: RoleRoute): RoleSettingValues => ({
  model: route.model || "(choose a model)",
  thinking: route.thinking,
  mode: route.mode,
  tools: toolsDisplayValue(route.tools),
  purpose: route.purpose?.trim() || "(none)",
  instructions: route.instructions?.trim() || "(none)",
  runner: optionalChoice(route.runner),
  transport: optionalChoice(route.transport),
  extensions: extensionChoice(route.extensions),
});

const cloneRoleDraft = (existing: RoleRoute): RoleRoute => ({
  ...existing,
  tools: [...existing.tools],
});

/**
 * Stateful role settings screen. All SettingsList callbacks update only a
 * private draft; the returned route is the sole commit point.
 */
export const editRole = async (
  context: ExtensionCommandContext,
  name: string,
  existing: RoleRoute,
): Promise<RoleRoute | undefined> => {
  const availableModels = context.modelRegistry.getAvailable().map((model) => ({
    provider: model.provider,
    id: model.id,
    name: model.name,
    input: model.input,
    reasoning: model.reasoning,
  }));
  if (availableModels.length === 0) {
    context.ui.notify("No available Pi models were found.", "warning");
    return undefined;
  }

  return context.ui.custom<RoleRoute | undefined>((tui, theme, _keybindings, done) => {
    const draft = cloneRoleDraft(existing);
    const commitOptionalString = (id: "purpose" | "instructions", value: string): void => {
      if (value.trim()) draft[id] = value;
      else delete draft[id];
    };
    const settings: SettingItem[] = [
      {
        id: "model",
        label: "Model",
        description: "Search the available Pi models and select one.",
        currentValue: draft.model || "(choose a model)",
        submenu: (_current, submenuDone) => new ModelSelectorComponent(theme, availableModels, draft.model, submenuDone),
      },
      {
        id: "thinking",
        label: "Thinking",
        description: "Reasoning effort for this role.",
        currentValue: draft.thinking,
        submenu: (current, submenuDone) => new RoleChoicePicker("Thinking level", THINKING_LEVEL_CHOICES, current, getSelectListTheme(), submenuDone),
      },
      {
        id: "mode",
        label: "Mode",
        description: "Role policy metadata used by the routing workflow.",
        currentValue: draft.mode,
        submenu: (current, submenuDone) => new RoleChoicePicker("Role mode", MODE_CHOICES, current, getSelectListTheme(), submenuDone),
      },
      {
        id: "tools",
        label: "Tools",
        description: "Choose the exact allowlist. An empty selection is valid.",
        currentValue: toolsDisplayValue(draft.tools),
        submenu: (_current, submenuDone) => new ToolSelectorComponent(
          theme,
          buildToolCatalog(draft.tools),
          draft.tools,
          (tools) => submenuDone(tools?.join(", ")),
        ),
      },
      {
        id: "purpose",
        label: "Purpose",
        currentValue: draft.purpose?.trim() || "(none)",
        submenu: (_current, submenuDone) => makeTextEditor(tui, theme, draft.purpose ?? "", false, submenuDone),
      },
      {
        id: "instructions",
        label: "Instructions",
        currentValue: draft.instructions?.trim() || "(none)",
        submenu: (_current, submenuDone) => makeTextEditor(tui, theme, draft.instructions ?? "", true, submenuDone),
      },
      {
        id: "runner",
        label: "Runner",
        currentValue: optionalChoice(draft.runner),
        submenu: (current, submenuDone) => new RoleChoicePicker("Runner", RUNNER_CHOICES, current, getSelectListTheme(), submenuDone),
      },
      {
        id: "transport",
        label: "Transport",
        currentValue: optionalChoice(draft.transport),
        submenu: (current, submenuDone) => new RoleChoicePicker("Transport", TRANSPORT_CHOICES, current, getSelectListTheme(), submenuDone),
      },
      {
        id: "extensions",
        label: "Extensions",
        currentValue: extensionChoice(draft.extensions),
        submenu: (current, submenuDone) => new RoleChoicePicker("Extensions", EXTENSION_CHOICES, current, getSelectListTheme(), submenuDone),
      },
      { id: "save", label: "Save", currentValue: "Save changes", values: ["Save changes"] },
      { id: "cancel", label: "Cancel", currentValue: "Discard changes", values: ["Discard changes"] },
    ];
    const container = new Container();
    container.addChild(new Text(theme.fg("accent", theme.bold(`Edit role: ${name}`)), 1, 1));
    container.addChild(new Text(theme.fg("muted", "Current values are shown below; changes are staged until Save."), 1, 0));
    const settingsList = new SettingsList(
      settings,
      Math.min(settings.length, 15),
      getSettingsListTheme(),
      (id, value) => {
        if (id === "save") {
          done({ ...draft, tools: [...draft.tools] });
          return;
        }
        if (id === "cancel") {
          done(undefined);
          return;
        }
        if (id === "model") draft.model = value;
        else if (id === "thinking") draft.thinking = value as ThinkingLevel;
        else if (id === "mode") draft.mode = value as RoleMode;
        else if (id === "tools") draft.tools = uniqueToolNames(value.split(","));
        else if (id === "purpose" || id === "instructions") commitOptionalString(id, value);
        else if (id === "runner") {
          if (value === "inherit") delete draft.runner;
          else draft.runner = value as RoleRunner;
        } else if (id === "transport") {
          if (value === "inherit") delete draft.transport;
          else draft.transport = value as RoleTransport;
        } else if (id === "extensions") {
          if (value === "inherit") delete draft.extensions;
          else draft.extensions = value === "enabled";
        }
      },
      () => done(undefined),
    );
    container.addChild(settingsList);
    return {
      render: (width) => container.render(width).map((line) => truncateToWidth(line, width)),
      handleInput: (data) => {
        settingsList.handleInput(data);
        tui.requestRender();
      },
      invalidate: () => container.invalidate(),
    };
  }, { overlay: true });
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

export const renameRole = async (context: ExtensionCommandContext, config: RoutingConfig, oldName: string): Promise<string | undefined> => {
  const newName = await context.ui.input("Rename role", oldName);
  if (newName === undefined || newName === oldName) return undefined;
  if (!ROLE_NAME_PATTERN.test(newName) || config.roles[newName]) {
    context.ui.notify(`Role names must match ${ROLE_NAME_PATTERN.source} and be unique.`, "warning");
    return undefined;
  }
  const references = [
    config.dispatch?.primaryRole === oldName ? "dispatch.primaryRole" : undefined,
    config.dispatch?.defaultImplementationRole === oldName ? "dispatch.defaultImplementationRole" : undefined,
  ].filter((value): value is string => value !== undefined);
  const fallbackMaterialization = oldName === "orchestrator" && config.dispatch?.primaryRole === undefined;
  const confirmed = await context.ui.confirm(
    `Rename ${oldName} to ${newName}?`,
    `${references.length > 0 ? `This migrates ${references.join(" and ")}. ` : ""}${fallbackMaterialization ? "This will set dispatch.primaryRole so automatic startup continues. " : ""}External dispatches and prompts using ${oldName} cannot be rewritten; they must use ${newName}. Continue?`,
  );
  if (!confirmed) return undefined;
  const migration = migrateRoleReferences(config, oldName, newName);
  saveRoutingConfig(migration.config);
  context.ui.notify(`Renamed ${oldName} to ${newName}. External dispatches and prompts must use ${newName}.`, "info");
  return newName;
};

const removeRole = async (context: ExtensionCommandContext, config: RoutingConfig, name: string): Promise<boolean> => {
  if (Object.keys(config.roles).length <= 1) {
    context.ui.notify("Cannot remove the last role; the routing file must contain at least one role.", "warning");
    return false;
  }
  const references = [
    config.dispatch?.primaryRole === name ? "dispatch.primaryRole" : undefined,
    config.dispatch?.defaultImplementationRole === name ? "dispatch.defaultImplementationRole" : undefined,
  ].filter((value): value is string => value !== undefined);
  const fallbackWarning = name === "orchestrator" && config.dispatch?.primaryRole === undefined
    ? " Automatic primary assignment will stop."
    : "";
  const confirmed = await context.ui.confirm(
    `Remove role ${name}?`,
    `This permanently removes the ${name} route from ${getRoutingConfigPath()}.${references.length > 0 ? ` It will clear ${references.join(" and ")}.` : ""}${fallbackWarning} Continue?`,
  );
  if (!confirmed) return false;
  const nextConfig = { ...config, roles: { ...config.roles } };
  delete nextConfig.roles[name];
  removeRoleReferences(nextConfig, name);
  saveRoutingConfig(nextConfig);
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
      const outcome = ensureRoutingConfig(context);
      if (outcome.created) {
        context.ui.notify(
          `Created Pi Fabric role routing at ${outcome.path} using the current model (${outcome.modelRef}). Edit roles with /fabric-role.`,
          "info",
        );
      } else if (outcome.reason === "no-model") {
        context.ui.notify(
          `Pi Fabric role routing could not be generated automatically: no current model is available. Select a model and start a new Pi session to retry, or create ${getRoutingConfigPath()} manually.`,
          "warning",
        );
      } else if (outcome.reason === "template" || outcome.reason === "write") {
        context.ui.notify(outcome.error, "warning");
      }
      // "exists" stays quiet so reload/resume/new sessions are not noisy.
    } catch (error) {
      context.ui.notify(error instanceof Error ? error.message : String(error), "warning");
    }
    // Apply the primary role only when a config is present; the warning above
    // already explains a missing config and applyPrimaryRole would only repeat it.
    if (existsSync(getRoutingConfigPath())) {
      try {
        await applyPrimaryRole(pi, context);
      } catch (error) {
        context.ui.notify(error instanceof Error ? error.message : String(error), "warning");
      }
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
      const config = loadRoutingConfig();
      const primaryName = resolvePrimaryRoleName(config);
      additions.push(formatRoleCatalog(config));
      const instructions = primaryName ? config.roles[primaryName]?.instructions?.trim() : undefined;
      if (instructions) additions.push(`Primary role (${primaryName}) instructions:\n${instructions}`);
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
