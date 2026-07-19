import type { Theme } from "@earendil-works/pi-coding-agent";
import {
  type Component,
  getKeybindings,
  Key,
  matchesKey,
  truncateToWidth,
} from "@earendil-works/pi-tui";

/** Built-in Pi tools are always offered, even when the current route has none. */
export const CANONICAL_TOOL_NAMES = [
  "read",
  "grep",
  "find",
  "ls",
  "edit",
  "write",
  "bash",
] as const;

/** Return unique, non-empty tool names without changing their first-seen order. */
export const uniqueToolNames = (tools: readonly string[]): string[] => {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const tool of tools) {
    const name = tool.trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    result.push(name);
  }
  return result;
};

/**
 * Build the checklist catalog from Pi's registered tools and the route itself.
 * Including current names means a temporarily unavailable/custom tool is not
 * silently dropped while editing or cancelling a route.
 */
export const buildToolCatalog = (
  existingTools: readonly string[] = [],
  availableTools: readonly string[] = [],
): string[] => uniqueToolNames([
  ...CANONICAL_TOOL_NAMES,
  ...availableTools,
  ...existingTools,
]);

/** Toggle one checklist item, returning a new selection in catalog order. */
export const toggleToolSelection = (
  selectedTools: readonly string[],
  tool: string,
  catalog: readonly string[] = [],
): string[] => {
  const selected = new Set(uniqueToolNames(selectedTools));
  if (selected.has(tool)) selected.delete(tool);
  else selected.add(tool);
  const order = catalog.length > 0 ? catalog : [...selected, tool];
  return uniqueToolNames(order).filter((name) => selected.has(name));
};

/** Keep cursor movement bounded and deterministic for the checklist. */
export const moveToolSelection = (
  selectedIndex: number,
  itemCount: number,
  direction: "up" | "down" | "pageUp" | "pageDown",
  pageSize = 8,
): number => {
  if (itemCount === 0) return 0;
  const delta = direction === "up"
    ? -1
    : direction === "down"
      ? 1
      : direction === "pageUp"
        ? -Math.max(1, pageSize)
        : Math.max(1, pageSize);
  return (selectedIndex + delta + itemCount) % itemCount;
};

/**
 * A transactional tool checklist. It owns a private Set until Enter/Ctrl+S;
 * Escape returns undefined and therefore cannot mutate the role draft.
 */
export class ToolSelectorComponent implements Component {
  private readonly theme: Theme;
  private readonly catalog: string[];
  private readonly done: (tools: string[] | undefined) => void;
  private readonly selected: Set<string>;
  private selectedIndex: number;
  private scrollStart = 0;
  private readonly maxVisible = 12;
  private closed = false;

  constructor(
    theme: Theme,
    catalog: readonly string[],
    currentTools: readonly string[],
    done: (tools: string[] | undefined) => void,
  ) {
    this.theme = theme;
    this.catalog = buildToolCatalog(currentTools, catalog);
    this.selected = new Set(uniqueToolNames(currentTools));
    this.selectedIndex = 0;
    this.done = done;
  }

  render(width: number): string[] {
    this.updateScroll();
    const lines = [
      this.theme.fg("accent", this.theme.bold("Select role tools")),
      this.theme.fg("muted", "Space toggles · Enter/Ctrl+S saves · Esc cancels"),
      "",
    ];
    if (this.catalog.length === 0) {
      lines.push(this.theme.fg("muted", "  No tools available"));
      return lines.map((line) => truncateToWidth(line, width));
    }

    const end = Math.min(this.scrollStart + this.maxVisible, this.catalog.length);
    for (let index = this.scrollStart; index < end; index += 1) {
      const tool = this.catalog[index];
      if (!tool) continue;
      const cursor = index === this.selectedIndex ? this.theme.fg("accent", "› ") : "  ";
      const mark = this.selected.has(tool)
        ? this.theme.fg("success", "[✓]")
        : this.theme.fg("dim", "[ ]");
      const label = `${cursor}${mark} ${tool}`;
      lines.push(index === this.selectedIndex ? this.theme.bg("selectedBg", label) : label);
    }
    if (this.scrollStart > 0 || end < this.catalog.length) {
      lines.push(this.theme.fg("dim", `  ${this.selectedIndex + 1}/${this.catalog.length}`));
    }
    lines.push("");
    lines.push(this.theme.fg("muted", `Selected: ${this.selectedSelection().join(", ") || "(none)"}`));
    return lines.map((line) => truncateToWidth(line, width));
  }

  handleInput(data: string): void {
    if (this.closed) return;
    const keybindings = getKeybindings();
    if (keybindings.matches(data, "tui.select.up")) {
      this.move("up");
    } else if (keybindings.matches(data, "tui.select.down")) {
      this.move("down");
    } else if (keybindings.matches(data, "tui.select.pageUp")) {
      this.move("pageUp");
    } else if (keybindings.matches(data, "tui.select.pageDown")) {
      this.move("pageDown");
    } else if (data === " " || matchesKey(data, Key.space)) {
      this.toggleCurrent();
    } else if (matchesKey(data, Key.ctrl("s")) || keybindings.matches(data, "tui.select.confirm")) {
      this.save();
    } else if (matchesKey(data, Key.escape) || keybindings.matches(data, "tui.select.cancel")) {
      this.cancel();
    }
  }

  invalidate(): void {
    // This component derives all display state during render.
  }

  private move(direction: "up" | "down" | "pageUp" | "pageDown"): void {
    this.selectedIndex = moveToolSelection(
      this.selectedIndex,
      this.catalog.length,
      direction,
      this.maxVisible,
    );
  }

  private toggleCurrent(): void {
    const tool = this.catalog[this.selectedIndex];
    if (!tool) return;
    if (this.selected.has(tool)) this.selected.delete(tool);
    else this.selected.add(tool);
  }

  private selectedSelection(): string[] {
    return this.catalog.filter((tool) => this.selected.has(tool));
  }

  private updateScroll(): void {
    if (this.selectedIndex < this.scrollStart) this.scrollStart = this.selectedIndex;
    if (this.selectedIndex >= this.scrollStart + this.maxVisible) {
      this.scrollStart = this.selectedIndex - this.maxVisible + 1;
    }
    this.scrollStart = Math.max(
      0,
      Math.min(this.scrollStart, Math.max(0, this.catalog.length - this.maxVisible)),
    );
  }

  private save(): void {
    this.closed = true;
    this.done(this.selectedSelection());
  }

  private cancel(): void {
    this.closed = true;
    this.done(undefined);
  }
}