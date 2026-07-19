import type { ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import { DynamicBorder } from "@earendil-works/pi-coding-agent";
import {
  Container,
  type Component,
  fuzzyFilter,
  getKeybindings,
  Input,
  Key,
  matchesKey,
  Spacer,
  Text,
} from "@earendil-works/pi-tui";

export type ModelSelectorModel = {
  provider: string;
  id: string;
  name: string;
  input?: readonly ("text" | "image")[];
  reasoning?: boolean;
};

export type ModelSelectorItem = {
  ref: string;
  provider: string;
  modelId: string;
  modelName: string;
  image: boolean;
  reasoning: boolean;
};

export const formatModelRef = (provider: string, id: string): string => `${provider}/${id}`;

/** Build display data without removing text-only models from the picker. */
export const buildModelSelectorItems = (models: ModelSelectorModel[]): ModelSelectorItem[] =>
  models.map((model) => ({
    ref: formatModelRef(model.provider, model.id),
    provider: model.provider,
    modelId: model.id,
    modelName: model.name || model.id,
    image: model.input?.includes("image") ?? false,
    reasoning: model.reasoning === true,
  }));

/** Fuzzy-search the provider, id, ref, and human-readable model name. */
export const filterModelSelectorItems = (
  items: ModelSelectorItem[],
  query: string,
): ModelSelectorItem[] => {
  const trimmed = query.trim();
  if (!trimmed) return items;
  return fuzzyFilter(items, trimmed, (item) =>
    `${item.provider} ${item.modelId} ${item.ref} ${item.modelName}`,
  );
};

/** Keep selection movement behavior deterministic and easy to test. */
export const moveModelSelection = (
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
 * Searchable model picker used by the role editor. It intentionally receives
 * already-available models from ModelRegistry, so unusable credentials never
 * appear as choices.
 */
export class ModelSelectorComponent implements Component {
  private readonly theme: Theme;
  private readonly done: (ref: string | undefined) => void;
  private readonly allItems: ModelSelectorItem[];
  private filteredItems: ModelSelectorItem[];
  private selectedIndex = 0;
  private scrollStart = 0;
  private readonly maxVisible = 8;
  private readonly searchInput: Input;
  private readonly listContainer: Container;
  private readonly detailContainer: Container;
  private readonly footerText: Text;
  private readonly currentRef?: string;
  private _focused = false;
  private closed = false;

  get focused(): boolean {
    return this._focused;
  }

  set focused(value: boolean) {
    this._focused = value;
    this.searchInput.focused = value;
  }

  constructor(
    theme: Theme,
    models: ModelSelectorModel[],
    currentRef: string | undefined,
    done: (ref: string | undefined) => void,
  ) {
    this.theme = theme;
    this.done = done;
    this.currentRef = currentRef;
    this.allItems = buildModelSelectorItems(models);
    this.filteredItems = this.allItems;
    this.selectedIndex = Math.max(0, this.allItems.findIndex((item) => item.ref === currentRef));

    this.searchInput = new Input();
    this.searchInput.onSubmit = () => this.confirmSelected();
    this.listContainer = new Container();
    this.detailContainer = new Container();
    this.footerText = new Text();
    this.updateList();
  }

  render(width: number): string[] {
    const lines: string[] = [
      ...new DynamicBorder((text) => this.theme.fg("borderAccent", text)).render(width),
      "",
      this.theme.fg("accent", this.theme.bold("Select a route model")),
      this.theme.fg("muted", "Available models only · search by provider, id, or name"),
      "",
      `${this.theme.fg("accent", "⌕ ")}${this.searchInput.render(width - 2).join("\n")}`,
      "",
      ...this.listContainer.render(width),
      ...this.detailContainer.render(width),
      "",
      ...this.footerText.render(width),
      ...new DynamicBorder((text) => this.theme.fg("borderAccent", text)).render(width),
    ];
    return lines;
  }

  handleInput(data: string): void {
    if (this.closed) return;
    const keybindings = getKeybindings();

    if (keybindings.matches(data, "tui.select.up")) {
      this.move("up");
      return;
    }
    if (keybindings.matches(data, "tui.select.down")) {
      this.move("down");
      return;
    }
    if (keybindings.matches(data, "tui.select.pageUp")) {
      this.move("pageUp");
      return;
    }
    if (keybindings.matches(data, "tui.select.pageDown")) {
      this.move("pageDown");
      return;
    }
    if (keybindings.matches(data, "tui.select.confirm")) {
      this.confirmSelected();
      return;
    }
    if (matchesKey(data, Key.escape)) {
      this.cancel();
      return;
    }
    if (matchesKey(data, Key.ctrl("c"))) {
      if (this.searchInput.getValue()) {
        this.searchInput.setValue("");
        this.refresh();
      } else {
        this.cancel();
      }
      return;
    }

    this.searchInput.handleInput(data);
    this.refresh();
  }

  invalidate(): void {
    this.searchInput.invalidate();
    this.listContainer.invalidate();
    this.detailContainer.invalidate();
    this.footerText.invalidate();
  }

  private move(direction: "up" | "down" | "pageUp" | "pageDown"): void {
    this.selectedIndex = moveModelSelection(
      this.selectedIndex,
      this.filteredItems.length,
      direction,
      this.maxVisible,
    );
    this.updateList();
  }

  private refresh(): void {
    const selectedRef = this.filteredItems[this.selectedIndex]?.ref;
    this.filteredItems = filterModelSelectorItems(this.allItems, this.searchInput.getValue());
    const preservedIndex = selectedRef
      ? this.filteredItems.findIndex((item) => item.ref === selectedRef)
      : -1;
    this.selectedIndex = preservedIndex >= 0
      ? preservedIndex
      : Math.min(this.selectedIndex, Math.max(0, this.filteredItems.length - 1));
    this.updateList();
  }

  private updateScroll(): void {
    if (this.selectedIndex < this.scrollStart) this.scrollStart = this.selectedIndex;
    if (this.selectedIndex >= this.scrollStart + this.maxVisible) {
      this.scrollStart = this.selectedIndex - this.maxVisible + 1;
    }
    this.scrollStart = Math.max(
      0,
      Math.min(this.scrollStart, Math.max(0, this.filteredItems.length - this.maxVisible)),
    );
  }

  private updateList(): void {
    this.updateScroll();
    this.listContainer.clear();
    this.detailContainer.clear();

    if (this.filteredItems.length === 0) {
      this.listContainer.addChild(new Text(this.theme.fg("muted", "  No matching models"), 0, 0));
      this.footerText.setText(this.footer());
      return;
    }

    const end = Math.min(this.scrollStart + this.maxVisible, this.filteredItems.length);
    for (let index = this.scrollStart; index < end; index += 1) {
      const item = this.filteredItems[index];
      if (!item) continue;
      const selected = index === this.selectedIndex;
      const marker = selected ? this.theme.fg("accent", "› ") : "  ";
      const name = selected ? this.theme.fg("accent", item.modelId) : item.modelId;
      const provider = this.theme.fg("muted", ` [${item.provider}]`);
      const badges = [
        item.image ? this.theme.fg("success", " image") : undefined,
        item.reasoning ? this.theme.fg("thinkingMedium", " reasoning") : undefined,
      ].filter(Boolean).join(this.theme.fg("dim", " ·"));
      const current = item.ref === this.currentRef ? this.theme.fg("success", " ✓") : "";
      const row = `${marker}${name}${provider}${badges ? ` ·${badges}` : ""}${current}`;
      this.listContainer.addChild(
        new Text(selected ? this.theme.bg("selectedBg", row) : row, 0, 0),
      );
    }

    if (this.scrollStart > 0 || end < this.filteredItems.length) {
      this.listContainer.addChild(
        new Text(
          this.theme.fg("dim", `  ${this.selectedIndex + 1}/${this.filteredItems.length} · ↑↓ navigate · pgup/pgdn scroll`),
          0,
          0,
        ),
      );
    }

    const selected = this.filteredItems[this.selectedIndex];
    if (selected) {
      this.detailContainer.addChild(new Spacer(1));
      this.detailContainer.addChild(
        new Text(this.theme.fg("accent", `  ${selected.modelName}`), 0, 0),
      );
      this.detailContainer.addChild(
        new Text(this.theme.fg("muted", `  ${selected.ref}`), 0, 0),
      );
      const capabilities = [
        selected.image ? this.theme.fg("success", "● image input") : this.theme.fg("dim", "○ text input only"),
        selected.reasoning ? this.theme.fg("thinkingMedium", "● reasoning") : this.theme.fg("dim", "○ no reasoning metadata"),
      ].join(this.theme.fg("dim", "  ·  "));
      this.detailContainer.addChild(new Text(`  ${capabilities}`, 0, 0));
      this.detailContainer.addChild(
        new Text(this.theme.fg("dim", "  The highlighted model will be saved for this role."), 0, 0),
      );
    }
    this.footerText.setText(this.footer());
  }

  private footer(): string {
    const count = this.searchInput.getValue()
      ? `${this.filteredItems.length} match${this.filteredItems.length === 1 ? "" : "es"}`
      : `${this.allItems.length} available`;
    return this.theme.fg(
      "dim",
      `  ${count} · enter select · esc cancel · ctrl+c ${this.searchInput.getValue() ? "clear search" : "cancel"}`,
    );
  }

  private confirmSelected(): void {
    const item = this.filteredItems[this.selectedIndex];
    if (!item) return;
    this.closed = true;
    this.done(item.ref);
  }

  private cancel(): void {
    this.closed = true;
    this.done(undefined);
  }
}

export const chooseModel = async (
  context: ExtensionCommandContext,
  current?: string,
): Promise<string | undefined> => {
  const available = context.modelRegistry.getAvailable();
  if (available.length === 0) {
    context.ui.notify("No available Pi models were found.", "warning");
    return undefined;
  }
  return context.ui.custom<string | undefined>(
    (_tui, theme, _keybindings, done) =>
      new ModelSelectorComponent(theme, available, current, done),
    { overlay: true },
  );
};