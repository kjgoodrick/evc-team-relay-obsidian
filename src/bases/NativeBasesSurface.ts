import { parseYaml, TFile } from "obsidian";
import { sha256Hex } from "../contentDigest";
import { isBaseDefinitionProperty, type BaseDefinitionProperty, type TimelineAxis } from "../collaboration/DiscussionProtocol";
import type { HistoricalPoint, TimelineRange } from "../collaboration/TimelineRange";
import { parseBaseRegistry, type BaseRegistrySnapshot } from "./BaseRegistryProtocol";
import { parseBasePresenceContext, type BasePresenceContext } from "../collaboration/presence/BasePresenceProtocol";
import { nativeBaseGroupValue, nativeBaseGroupValueKey, nativeGroupValueBudget, type NativeBaseGroupValue, type NativeGroupLinkResolver } from "./NativeBaseGroupValue";

/** Private built-in renderer contract, observed in desktop Obsidian 1.13.7.
 * Unknown hosts/layouts return no adapter. No saved configuration is written.
 * Keep this boundary separate from managed identity, authorization and comments.
 */
export const NATIVE_BASES_VERSIONS: readonly string[] = ["1.13.7"];
const MAX_MODELS = 20_000;
const MAX_HANDLES = 2_048;
type ObjectValue = Record<string, unknown>;
const object = (value: unknown): value is ObjectValue => !!value && typeof value === "object" && !Array.isArray(value);
const list = (value: unknown, limit = MAX_MODELS): unknown[] | undefined => Array.isArray(value) && value.length <= limit ? value : undefined;
const element = (value: unknown): value is HTMLElement => object(value) && value.nodeType === 1 && typeof value.contains === "function" && typeof value.getBoundingClientRect === "function";
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;
const callable = (value: unknown): value is (...args: unknown[]) => unknown => typeof value === "function";

/** Reject cycles, YAML objects and oversized trees; never stringify unbounded host state. */
export function baseConfigurationKey(value: unknown): string | undefined {
	let remaining = 16_000, characters = 0;
	const seen = new Set<object>();
	function visit(node: unknown, depth: number): unknown {
		if (--remaining < 0 || depth > 32) throw new Error("Configuration exceeds adapter limits");
		if (node === null || typeof node === "boolean") return node;
		if (typeof node === "string") { characters += node.length; if (characters > 262_144) throw new Error("Configuration too large"); return node; }
		if (typeof node === "number" && Number.isFinite(node)) return node;
		if (typeof node !== "object" || !node || seen.has(node)) throw new Error("Unsupported configuration");
		seen.add(node);
		try {
			if (Array.isArray(node)) return node.map(child => visit(child, depth + 1));
			const prototype = Object.getPrototypeOf(node);
			if (prototype !== null && prototype !== Object.prototype) throw new Error("Unsupported configuration object");
			return Object.fromEntries(Object.keys(node).sort().map(key => {
				characters += key.length; if (characters > 262_144) throw new Error("Configuration too large");
				return [key, visit((node as ObjectValue)[key], depth + 1)];
			}));
		} finally { seen.delete(node); }
	}
	try { return JSON.stringify(visit(value, 0)); } catch { return undefined; }
}

export function nativeBaseProperty(value: unknown): BaseDefinitionProperty | undefined {
	if (typeof value !== "string") return;
	const dot = value.indexOf("."), candidate = { source: value.slice(0, dot), name: value.slice(dot + 1) };
	return dot > 0 && isBaseDefinitionProperty(candidate) ? candidate : undefined;
}

export type NativeBaseTarget = { type: "view" } | { type: "item"; file: TFile } |
	{ type: "cell"; file: TFile; property: BaseDefinitionProperty } | { type: "property"; property: BaseDefinitionProperty };
export interface NativeBaseHandle { target: NativeBaseTarget; element: HTMLElement | SVGElement; current(): boolean }
export interface NativeBaseGroupTarget { type: "group"; property: BaseDefinitionProperty; value: NativeBaseGroupValue }
export interface NativeBaseGroupHandle {
	target: NativeBaseGroupTarget; element: HTMLElement | SVGElement;
	/** One native header can represent several typed values. Capture must offer
	 * the distinct choices instead of choosing whichever record was sorted first. */
	ambiguous: boolean; current(): boolean;
	/** Bounded, current source candidates for this exact typed value. */
	members(): TFile[];
}
export type NativeBaseReveal = "revealed" | "hidden" | "property-hidden" | "unavailable" | "busy" | "ambiguous";
export interface NativeBaseGroupLocation {
	group: unknown; element: HTMLElement | SVGElement; current(): boolean; reveal(): NativeBaseReveal;
}
export interface NativeTimelineContext {
	axis: TimelineAxis; effectiveTimeZone: string | null; kinds: readonly TimelineRange["kind"][]; current(): boolean;
}
export interface NativeTimelineSelection {
	context: NativeTimelineContext; draft?: Record<string, unknown>; issue?: string; current(): boolean;
}
export interface NativeTimelineGeometry {
	startX: number; endX: number; top: number; bottom: number; discontinuous: boolean; current(): boolean;
}
export interface NativeBasesExtension {
	owner: unknown; root: HTMLElement; current(): boolean; viewport(): HTMLElement | undefined;
	handles(): NativeBaseHandle[]; hit(node: Node, point?: { clientX: number; clientY: number }): NativeBaseHandle | undefined;
	reveal(target: NativeBaseTarget): NativeBaseReveal;
	groups?(): NativeBaseGroupLocation[];
	rangeContext?(): NativeTimelineContext | undefined;
	rangeGeometry?(range: TimelineRange, axis: TimelineAxis, group?: unknown): NativeTimelineGeometry | undefined;
	revealRange?(range: TimelineRange, axis: TimelineAxis, group?: unknown): NativeBaseReveal;
	beginRange?(kind: TimelineRange["kind"], precision: HistoricalPoint["precision"], select: (selection: NativeTimelineSelection) => void, stopped: () => void): (() => void) | undefined;
	beginAnnotation(select: (handle: NativeBaseHandle) => void, stopped: () => void, group?: (location: NativeBaseGroupLocation) => void): (() => void) | undefined;
}
export interface NativeBasesIntegrations {
	find(owner: unknown): NativeBasesExtension | undefined;
	supports(type: string): boolean;
	canNavigate(document: Document): boolean;
}
export interface NativeBaseBinding {
	snapshot: BaseRegistrySnapshot; viewId: string; name: string; type: string; current(): boolean;
}
export interface NativeBasePresenceBinding {
	context: BasePresenceContext; viewId: string; name: string; type: string; current(): boolean;
}

function propertyEqual(a: BaseDefinitionProperty, b: BaseDefinitionProperty): boolean { return a.source === b.source && a.name === b.name; }
function sameTarget(a: NativeBaseTarget, b: NativeBaseTarget): boolean {
	return a.type === b.type && (!("file" in a) || "file" in b && a.file === b.file) &&
		(!("property" in a) || "property" in b && propertyEqual(a.property, b.property));
}

export class NativeBasesSurface {
	readonly file: TFile;
	readonly root: HTMLElement;
	readonly name: string;
	readonly type: "table" | "cards" | "list" | "sabidurian-timeline" | "sabidurian-sequence";
	readonly slot: number;
	readonly source: string;
	private readonly key: string;
	private readonly data: unknown;
	private bindings = new WeakSet<NativeBaseBinding>();
	private presenceBindings = new WeakSet<NativeBasePresenceBinding>();
	private constructor(private host: ObjectValue, private controller: ObjectValue, private renderer: ObjectValue, private query: ObjectValue,
		private config: ObjectValue, file: TFile, slot: number, key: string,
		private integrations?: NativeBasesIntegrations, private external?: NativeBasesExtension) {
		this.file = file; this.root = host.contentEl as HTMLElement; this.name = config.name as string;
		this.type = renderer.type as NativeBasesSurface["type"]; this.slot = slot; this.source = host.data as string; this.key = key;
		this.data = renderer.data;
	}
	static inspect(host: unknown, version: string, enabled = true, integrations?: NativeBasesIntegrations): NativeBasesSurface | undefined {
		if (!enabled || !NATIVE_BASES_VERSIONS.includes(version)) return;
		try {
			if (!object(host) || !callable(host.getViewType) || host.getViewType() !== "bases" || !(host.file instanceof TFile) ||
				host.file.extension !== "base" || typeof host.file.path !== "string" || !element(host.contentEl) || !host.contentEl.isConnected ||
				typeof host.data !== "string" || host.data.length > 262_144 || host.lastSavedData !== host.data || host.dirty !== false) return;
			const controller = host.controller, query = host.query;
			if (!object(controller) || controller.initialScan !== false || !object(query) || controller.query !== query || query.file !== host.file || !callable(query.getSerializable)) return;
			const renderer = controller.view;
			if (!object(renderer)) return;
			const builtin = ["table", "cards", "list"].includes(String(renderer.type));
			const external = !builtin && integrations?.supports(String(renderer.type)) ? integrations.find(renderer) : undefined;
			const container = external?.root ?? renderer.containerEl;
			if (((!builtin || renderer.queryController !== controller) && !external) ||
				!object(renderer.config) || !object(renderer.data) || !list(renderer.data.groupedData, 256) || !element(container) || !host.contentEl.contains(container) ||
				external && (external.owner !== renderer || !external.current())) return;
			const config = renderer.config, views = list(query.views, 64), slot = views?.indexOf(config) ?? -1;
			if (slot < 0 || !views || views.filter(view => object(view) && view.name === config.name).length !== 1 ||
				config.query !== query || config.type !== renderer.type || config.name !== controller.viewName || typeof config.name !== "string") return;
			const key = baseConfigurationKey(query.getSerializable()), parsed = parseYaml(host.data) as unknown;
			if (!key || !baseConfigurationKey(parsed) || !object(parsed) || !Array.isArray(parsed.views) || parsed.views.length !== views.length ||
				!object(parsed.views[slot]) || parsed.views[slot].name !== config.name || parsed.views[slot].type !== config.type) return;
			// The host serializes note.status as status, and normalizes several
			// other supported options. Its pure parser gives an equivalent model
			// without reproducing that private normalization or writing the file.
			const queryType = query.constructor, parse = callable(queryType) ? (queryType as unknown as ObjectValue).parse : undefined;
			if (!callable(parse)) return;
			const normalized = parse.call(queryType, parsed);
			if (!object(normalized) || normalized === query || normalized.file !== undefined || normalized.saveFn !== undefined ||
				!callable(normalized.getSerializable) || baseConfigurationKey(normalized.getSerializable()) !== key) return;
			return new NativeBasesSurface(host, controller, renderer, query, config, host.file, slot, key, integrations, external);
		} catch { return; }
	}
	/** Cheap ownership checks plus bounded semantic comparison at action/render boundaries. */
	current(): boolean {
		try {
			return this.host.file === this.file && this.host.controller === this.controller && this.host.query === this.query &&
				this.controller.initialScan === false && this.controller.query === this.query && this.controller.view === this.renderer && this.renderer.config === this.config && this.renderer.data === this.data &&
				this.config.name === this.name && this.config.type === this.type && this.controller.viewName === this.name &&
				this.host.data === this.source && this.host.lastSavedData === this.source && this.host.dirty === false &&
				this.root.isConnected && (this.external ? this.external.current() && this.external.owner === this.renderer && this.root.contains(this.external.root) : element(this.renderer.containerEl) && this.root.contains(this.renderer.containerEl)) &&
				list(this.query.views, 64)?.[this.slot] === this.config && callable(this.query.getSerializable) && baseConfigurationKey(this.query.getSerializable()) === this.key;
		} catch { return false; }
	}
	/** Verify exact disk bytes, runtime configuration and registry before assigning a scope.
	 * The caller also fences account, inventory, permissions and registry revision. */
	async bind(snapshot: BaseRegistrySnapshot, entryId: string, read: () => Promise<string>, current: () => boolean): Promise<NativeBaseBinding | undefined> {
		try {
			if (!this.current() || !current()) return;
			const verified = parseBaseRegistry(snapshot, entryId), view = verified.views[this.slot];
			if (!view?.id || view.name !== this.name || view.type !== this.type) return;
			const { mtime, size } = this.file.stat;
			const unchanged = () => this.file.stat.mtime === mtime && this.file.stat.size === size;
			const source = await read();
			if (source !== this.source || new TextEncoder().encode(source).byteLength > 262_144) return;
			if (await sha256Hex(new TextEncoder().encode(source).buffer) !== verified.content_sha256 || !current() || !this.current() || !unchanged()) return;
			const binding = { snapshot: verified, viewId: view.id, name: view.name, type: view.type, current: () => current() && unchanged() && this.current() };
			this.bindings.add(binding); return binding;
		} catch { return; }
	}
	activateView(viewId: string, binding: NativeBaseBinding): boolean {
		try {
			if (!this.bindings.has(binding) || !binding.current() || !this.current() || !callable(this.controller.selectView) || this.integrations?.canNavigate(this.root.ownerDocument) === false) return false;
			const next = binding.snapshot.views.find(view => view.id === viewId);
			if (!next || !["table", "cards", "list"].includes(next.type) && !this.integrations?.supports(next.type)) return false;
			this.controller.selectView(next.name); return true;
		} catch { return false; }
	}
	/** Presence uses an existing read-only identity context, independent of a
	 * discussion session. Unmatched slots never acquire an inferred identity.
	 * The caller's current() fences account, inventory, access and registry changes. */
	async bindPresence(context: BasePresenceContext, shareId: string, entryId: string, read: () => Promise<string>, current: () => boolean): Promise<NativeBasePresenceBinding | undefined> {
		try {
			if (!this.current() || !current()) return;
			const verified = parseBasePresenceContext(context, shareId, entryId), view = verified.views.find(view => view.slot === this.slot);
			if (!view || view.name !== this.name || view.type !== this.type) return;
			const saved = parseYaml(this.source) as unknown;
			if (!object(saved) || !Array.isArray(saved.views) || verified.views.some(view => {
				const candidate = (saved.views as unknown[])[view.slot];
				return !object(candidate) || candidate.name !== view.name || candidate.type !== view.type;
			})) return;
			const { mtime, size } = this.file.stat;
			const unchanged = () => this.file.stat.mtime === mtime && this.file.stat.size === size;
			const source = await read();
			if (source !== this.source || new TextEncoder().encode(source).byteLength > 262_144) return;
			if (await sha256Hex(new TextEncoder().encode(source).buffer) !== verified.content_sha256 || !current() || !this.current() || !unchanged()) return;
			const binding = { context: verified, viewId: view.id, name: view.name, type: view.type, current: () => current() && unchanged() && this.current() };
			this.presenceBindings.add(binding); return binding;
		} catch { return; }
	}
	activatePresenceView(viewId: string, binding: NativeBasePresenceBinding): boolean {
		try {
			if (!this.presenceBindings.has(binding) || !binding.current() || !this.current() || !callable(this.controller.selectView) || this.integrations?.canNavigate(this.root.ownerDocument) === false) return false;
			const next = binding.context.views.find(view => view.id === viewId);
			if (!next || !["table", "cards", "list"].includes(next.type) && !this.integrations?.supports(next.type)) return false;
			const target = list(this.query.views, 64)?.[next.slot];
			if (!object(target) || target.name !== next.name || target.type !== next.type) return false;
			this.controller.selectView(next.name); return true;
		} catch { return false; }
	}
	viewport(): HTMLElement | undefined { return this.current() ? this.scrollElement() : undefined; }
	get annotationSupported(): boolean { return !!this.external; }
	rangeContext(): NativeTimelineContext | undefined {
		const context = this.current() ? this.external?.rangeContext?.() : undefined;
		return context?.current() ? { ...context, current: () => this.current() && context.current() } : undefined;
	}
	rangeGeometry(range: TimelineRange, axis: TimelineAxis, groupElement?: Element): NativeTimelineGeometry | undefined {
		if (!this.current()) return;
		const groups = groupElement ? (this.groupLocations() ?? []).filter(location => location.element === groupElement && location.current()) : [];
		if (groupElement && groups.length !== 1) return;
		const geometry = this.external?.rangeGeometry?.(range, axis, groups[0]?.group);
		return geometry?.current() ? { ...geometry, current: () => this.current() && (!groups[0] || groups[0].current()) && geometry.current() } : undefined;
	}
	revealRange(range: TimelineRange, axis: TimelineAxis, current: () => boolean, groupElement?: Element): NativeBaseReveal {
		if (!this.current() || !current()) return "unavailable";
		const groups = groupElement ? (this.groupLocations() ?? []).filter(location => location.element === groupElement && location.current()) : [];
		if (groupElement && groups.length !== 1) return "unavailable";
		return this.external?.revealRange?.(range, axis, groups[0]?.group) ?? "unavailable";
	}
	beginRange(kind: TimelineRange["kind"], precision: HistoricalPoint["precision"], select: (selection: NativeTimelineSelection) => void, stopped: () => void): (() => void) | undefined {
		if (!this.current()) return;
		return this.external?.beginRange?.(kind, precision, value => { if (this.current() && value.current()) {
			select({ ...value, context: { ...value.context, current: () => this.current() && value.context.current() }, current: () => this.current() && value.current() });
		} }, stopped);
	}
	beginAnnotation(select: (handle: NativeBaseHandle) => void, stopped: () => void, group?: (location: NativeBaseGroupLocation) => void): (() => void) | undefined {
		if (!this.current()) return;
		return this.external?.beginAnnotation(handle => { if (this.current() && handle.current()) select(handle); }, stopped,
			location => { if (this.current() && location.current()) group?.(location); });
	}
	private rows(): ObjectValue[] | undefined {
		if (this.type === "table" || this.type === "cards") {
			const rows = list(this.type === "table" ? this.renderer.rows : this.renderer.items);
			return rows?.every(object) ? rows : undefined;
		}
		const groups = list(this.renderer.groups, 256), rows: ObjectValue[] = [];
		if (!groups) return;
		for (const group of groups) {
			const items = object(group) ? list(group.rows) : undefined;
			if (!items || !items.every(object) || rows.length + items.length > MAX_MODELS) return;
			rows.push(...items);
		}
		return rows;
	}
	/** Only mounted models produce handles. Text, CSS order and row indexes are never identities. */
	handles(): NativeBaseHandle[] {
		if (!this.current()) return [];
		if (this.external) {
			const root = this.external.root;
			return [{ target: { type: "view" }, element: root, current: () => this.current() },
				...this.external.handles().map(handle => ({ ...handle, current: () => this.current() && handle.current() }))];
		}
		const output: NativeBaseHandle[] = [], container = this.renderer.containerEl as HTMLElement;
		const add = (target: NativeBaseTarget, node: unknown, live: () => boolean) => {
			if (!element(node) || !node.isConnected || !this.root.contains(node)) return;
			output.push({ target, element: node, current: () => this.current() && node.isConnected && this.root.contains(node) && live() });
		};
		add({ type: "view" }, container, () => this.renderer.containerEl === container);
		const rows = this.rows(), entries = this.entries(); if (!rows || !entries) return [];
		for (const row of rows) {
			if (!element(row.el) || !row.el.isConnected || !object(row.entry)) continue;
			const entry = row.entry; if (!(entry.file instanceof TFile)) continue;
			const file = entry.file;
			const live = () => row.entry === entry && entry.file === file && row.view === this.renderer && this.rows()?.includes(row) === true && this.entries()?.has(entry) === true;
			if (row.view !== this.renderer || !entries.has(entry)) continue;
			add({ type: "item", file }, row.el, live);
			const cells = list(this.type === "cards" ? row.props : row.cells, 256);
			if (!cells) return [];
			for (const cell of cells) {
				if (!object(cell)) return [];
				const id = this.type === "list" ? cell.propertyId : cell.prop, property = nativeBaseProperty(id);
				if (!property || !element(cell.el) || !row.el.contains(cell.el)) continue;
				const propertyLive = () => live() && cell.view === this.renderer && (this.type === "list" ? cell.propertyId === id && cell.entry === entry : cell.prop === id) &&
					list(this.type === "cards" ? row.props : row.cells, 256)?.includes(cell) === true;
				if (cell.view === this.renderer && (this.type !== "list" || cell.entry === entry)) add({ type: "cell", file, property }, cell.el, propertyLive);
			}
			if (output.length > MAX_HANDLES) return [];
		}
		if (this.type === "table" && object(this.renderer.header)) {
			const header = this.renderer.header, cells = list(header.cells, 256); if (!cells) return [];
			for (const cell of cells) {
				if (!object(cell)) return [];
				const property = nativeBaseProperty(cell.prop); if (!property) continue;
				const prop = cell.prop;
				add({ type: "property", property }, cell.el, () => this.renderer.header === header && cell.view === this.renderer && cell.prop === prop && list(header.cells, 256)?.includes(cell) === true);
			}
		}
		return output.length <= MAX_HANDLES ? output : [];
	}
	hit(node: Node, point?: { clientX: number; clientY: number }): NativeBaseHandle | undefined {
		if (!this.current()) return;
		if (this.external) {
			const handle = this.external.hit(node, point);
			return handle ? { ...handle, current: () => this.current() && handle.current() } : undefined;
		}
		// Group headings have their own typed capture API. A header that is not
		// wired/supported must not silently become a whole-view discussion.
		const grouped = this.groups(), models = list(this.renderer.groups, 256);
		if (grouped && models?.length === grouped.length && grouped.some((group, index) => {
			const model = models[index]; return object(model) && this.groupHeading(model, group)?.contains(node);
		})) return;
		// Unsupported third-party cells must not silently become row or view comments.
		for (const row of this.rows() ?? []) {
			if (!element(row.el) || !row.el.contains(node)) continue;
			for (const cell of list(this.type === "cards" ? row.props : row.cells, 256) ?? []) {
				if (object(cell) && element(cell.el) && cell.el.contains(node) && !nativeBaseProperty(this.type === "list" ? cell.propertyId : cell.prop)) return;
			}
		}
		// Descendants win: a cell is more specific than its row and view container.
		return this.handles().filter(handle => handle.element.contains(node)).sort((a, b) => a.element === b.element ? 0 : a.element.contains(b.element) ? 1 : -1)[0];
	}
	private groups(): ObjectValue[] | undefined {
		const data = this.renderer.data, groups = object(data) ? list(data.groupedData, 256) : undefined;
		return groups?.every(group => object(group) && !!list(group.entries)) ? groups as ObjectValue[] : undefined;
	}
	private groupingProperty(): BaseDefinitionProperty | undefined {
		return object(this.config.groupBy) ? nativeBaseProperty(this.config.groupBy.property) : undefined;
	}
	private groupHeading(model: ObjectValue, group: ObjectValue): HTMLElement | undefined {
		if (model.view !== this.renderer) return;
		if (this.type === "table") {
			if (!element(model.tableEl) || !this.root.contains(model.tableEl)) return;
			const headings = Array.from(model.tableEl.children).filter(child => child.classList.contains("bases-group-heading"));
			return headings.length === 1 && element(headings[0]) ? headings[0] : undefined;
		}
		if (this.type === "list" && model.group !== group) return;
		return element(model.groupHeadingEl) && model.groupHeadingEl.isConnected && this.root.contains(model.groupHeadingEl) ? model.groupHeadingEl : undefined;
	}
	private groupValues(group: ObjectValue, property: BaseDefinitionProperty, resolve: NativeGroupLinkResolver, budget = nativeGroupValueBudget()): Map<string, NativeBaseGroupValue> | undefined {
		const entries = list(group.entries); if (!entries || entries.length === 0) return;
		const values = new Map<string, NativeBaseGroupValue>();
		for (const entry of entries) {
			if (!object(entry) || !(entry.file instanceof TFile) || !callable(entry.getValue)) return;
			const value = nativeBaseGroupValue(entry.getValue(property.source + "." + property.name), resolve, budget);
			// Unsupported members cannot silently become a different representative
			// target or a whole-view comment. The sidebar can explain this boundary.
			if (!value) return;
			values.set(nativeBaseGroupValueKey(value), value);
			if (values.size > 256) return;
		}
		return values;
	}
	private groupLocations(): (NativeBaseGroupLocation & { group: ObjectValue })[] | undefined {
		const groups = this.groups(); if (!groups) return;
		if (this.external) {
			const locations = this.external.groups?.() ?? []; if (locations.length > 256) return;
			const seen = new Set<unknown>(), elements = new Set<Element>(), verified: (NativeBaseGroupLocation & { group: ObjectValue })[] = [];
			for (const location of locations) {
				const group = location.group;
				if (!object(group) || !groups.includes(group) || seen.has(group) || elements.has(location.element) ||
					!element(location.element) || !this.root.contains(location.element) || !location.current()) return;
				seen.add(group); elements.add(location.element);
				verified.push({ ...location, group, current: () => this.current() && this.groups()?.includes(group) === true && location.current() });
			}
			return verified;
		}
		const models = list(this.renderer.groups, 256); if (!models || groups.length !== models.length) return;
		const locations: (NativeBaseGroupLocation & { group: ObjectValue })[] = [];
		for (let slot = 0; slot < groups.length; slot++) {
			const group = groups[slot], model = models[slot]; if (!object(model)) return;
			const heading = this.groupHeading(model, group); if (!heading?.isConnected) continue;
			const current = () => this.current() && this.groups()?.[slot] === group && list(this.renderer.groups, 256)?.[slot] === model &&
				this.groupHeading(model, group) === heading && heading.isConnected;
			locations.push({ group, element: heading, current, reveal: () => {
				if (!current()) return "unavailable";
				heading.scrollIntoView({ block: "nearest", inline: "nearest" }); return "revealed";
			} });
		}
		return locations;
	}
	/** Explicit-action API until group capture/authorization is connected. It
	 * neither exports member values nor treats local membership as authority. */
	groupHandles(resolve: NativeGroupLinkResolver): NativeBaseGroupHandle[] {
		try {
			if (!this.current()) return [];
			const property = this.groupingProperty(), locations = this.groupLocations();
			if (!property || !locations || !this.entries()) return [];
			const handles: NativeBaseGroupHandle[] = [], budget = nativeGroupValueBudget();
			for (const location of locations) {
				const { group, element: heading } = location;
				const values = this.groupValues(group, property, resolve, budget);
				if (budget.nodes < 0 || budget.characters < 0) return [];
				if (!values) continue;
				for (const [key, value] of [...values.entries()].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) {
					handles.push({ target: { type: "group", property, value }, element: heading, ambiguous: values.size > 1, current: () => {
						try {
							if (!location.current() || nativeBaseGroupValueKey(value) !== key) return false;
							const currentValues = this.groupValues(group, property, resolve);
							return currentValues?.size === values.size && [...values.keys()].every(captured => currentValues.has(captured));
						} catch { return false; }
					}, members: () => {
						try {
							if (!location.current()) return [];
							const entries = list(group.entries); if (!entries) return [];
							const members = new Set<TFile>(), budget = nativeGroupValueBudget();
							for (const entry of entries) {
								if (!object(entry) || !(entry.file instanceof TFile) || !callable(entry.getValue)) return [];
								const value = nativeBaseGroupValue(entry.getValue(property.source + "." + property.name), resolve, budget);
								if (!value) return [];
								if (nativeBaseGroupValueKey(value) === key) members.add(entry.file);
							}
							return [...members];
						} catch { return []; }
					} });
				}
				if (handles.length > MAX_HANDLES) return [];
			}
			return handles;
		} catch { return []; }
	}
	groupHit(node: Node, resolve: NativeGroupLinkResolver): NativeBaseGroupHandle[] {
		return this.groupHandles(resolve).filter(handle => handle.element.contains(node));
	}
	/** Headers are mounted for all three verified built-in layouts, including
	 * offscreen groups. Scrolling never expands a lane or changes saved filters. */
	revealGroup(target: NativeBaseGroupTarget, resolve: NativeGroupLinkResolver, authorized: () => boolean): NativeBaseReveal {
		try {
			if (!authorized() || !this.current()) return "unavailable";
			if (this.integrations?.canNavigate(this.root.ownerDocument) === false) return "busy";
			const property = this.groupingProperty();
			if (!property || !propertyEqual(property, target.property)) return "unavailable";
			const key = nativeBaseGroupValueKey(target.value), groups = this.groups(); if (!groups || !this.entries()) return "unavailable";
			let exists = false; const budget = nativeGroupValueBudget();
			for (const group of groups) {
				const values = this.groupValues(group, property, resolve, budget); if (!values) return "unavailable";
				if (values.has(key)) exists = true;
			}
			if (!exists) return "hidden";
			// Loose equality is not transitive (for example date-only vs instants),
			// so the same typed value may occur under two different native headers.
			// Keep the target but refuse to guess which header to reveal.
			const matches = this.groupHandles(resolve).filter(handle => nativeBaseGroupValueKey(handle.target.value) === key);
			if (matches.length !== 1 || !matches[0].current() || !authorized() || !this.current()) return "unavailable";
			const locations = this.groupLocations()?.filter(location => location.element === matches[0].element && location.current());
			return locations?.length === 1 && authorized() && this.current() ? locations[0].reveal() : "unavailable";
		} catch { return "unavailable"; }
	}
	private entries(): Set<unknown> | undefined {
		const groups = this.groups(), entries = new Set<unknown>(); if (!groups) return;
		let count = 0;
		for (const group of groups) {
			const items = group.entries as unknown[]; count += items.length; if (count > MAX_MODELS) return;
			for (const entry of items) entries.add(entry);
		}
		return entries;
	}
	private propertyDisplayed(property: BaseDefinitionProperty): boolean {
		const data = this.renderer.data, properties = this.type === "list" ? this.renderer.order : object(data) ? data.properties : undefined;
		return list(properties, 256)?.includes(property.source + "." + property.name) === true;
	}
	private scrollElement(): HTMLElement | undefined {
		if (this.external) return this.external.viewport();
		const scroll = this.type === "list" && element(this.renderer.containerEl) ? this.renderer.containerEl.parentElement : this.renderer.scrollEl;
		return element(scroll) && this.root.contains(scroll) ? scroll : undefined;
	}
	/** Geometry derives from the matched record's current query entry. Indexes here
	 * are transient layout coordinates only. Never select/edit a native cell. */
	private position(file: TFile, property?: BaseDefinitionProperty): { top: number; left?: number } | undefined {
		const data = this.renderer.data, groups = this.groups(), nativeGroups = list(this.renderer.groups, 256), scroll = this.scrollElement();
		if (!object(data) || !groups || !nativeGroups || !scroll) return;
		let count = 0;
		for (let groupIdx = 0; groupIdx < groups.length; groupIdx++) {
			const entries = groups[groupIdx].entries as unknown[]; count += entries.length; if (count > MAX_MODELS) return;
			const row = entries.findIndex(entry => object(entry) && entry.file === file); if (row < 0) continue;
			const group = nativeGroups[groupIdx]; if (!object(group)) return;
			if (this.type === "table") {
				const properties = list(data.properties, 256), column = property ? properties?.indexOf(property.source + "." + property.name) ?? -1 : 0;
				if (column < 0 || !properties?.length || !callable(this.renderer.getCellRect) || !element(group.tbodyEl) || !group.tbodyEl.isConnected) return;
				const rect = this.renderer.getCellRect({ groupIdx, row, column });
				return object(rect) && typeof rect.top === "number" && Number.isFinite(rect.top) && finite(rect.left) ? { top: Math.max(0, rect.top), left: rect.left } : undefined;
			}
			if (this.type === "cards") {
				const m = this.renderer.measurements;
				if (!object(m) || !finite(m.cardHeight) || !finite(m.cardGap) || !Number.isInteger(m.cardsPerRow) || !finite(m.cardsPerRow) || m.cardsPerRow < 1 ||
					!object(m.groupPad) || !finite(m.groupPad.top) || !element(group.containerEl) || !group.containerEl.isConnected) return;
				return { top: Math.max(0, group.containerEl.getBoundingClientRect().top - scroll.getBoundingClientRect().top + scroll.scrollTop + m.groupPad.top + Math.floor(row / m.cardsPerRow) * (m.cardHeight + m.cardGap)) };
			}
			const rows = list(group.rows); if (!rows || !finite(group.headerHeight)) return;
			let top = group.headerHeight;
			for (let index = 0; index < groupIdx; index++) { const before = nativeGroups[index]; if (!object(before) || !finite(before.height)) return; top += before.height; }
			for (const item of rows) {
				if (!object(item) || !object(item.entry) || !finite(item.height)) return;
				if (item.entry.file === file) return { top };
				top += item.height;
			}
		}
	}
	private nextFrame(): Promise<void> {
		return new Promise(resolve => {
			const window = this.root.ownerDocument.defaultView; if (!window) { resolve(); return; }
			let frame = 0, timer = 0;
			const finish = () => { window.cancelAnimationFrame(frame); window.clearTimeout(timer); resolve(); };
			frame = window.requestAnimationFrame(finish);
			// Background windows may suspend animation callbacks. Do not retain a
			// navigation promise indefinitely when a pane closes or loses focus.
			timer = window.setTimeout(finish, 100);
		});
	}
	async reveal(target: NativeBaseTarget, authorized: () => boolean, frame = () => this.nextFrame()): Promise<NativeBaseReveal> {
		const current = () => authorized() && this.current();
		let restore: (() => void) | undefined;
		try {
			if (!current()) return "unavailable";
			if (this.integrations?.canNavigate(this.root.ownerDocument) === false) return "busy";
			if (this.external) return this.external.reveal(target);
			const groups = this.groups(); if (!groups) return "unavailable";
			if ("file" in target && !groups.some(group => (group.entries as unknown[]).some(entry => object(entry) && entry.file === target.file))) return "hidden";
			if ("property" in target && !this.propertyDisplayed(target.property)) return "property-hidden";
			let handle = this.handles().find(item => sameTarget(item.target, target));
			if (!handle && target.type === "property") return "property-hidden";
			const scroll = this.scrollElement(); if (!scroll) return "unavailable";
			const before = { top: scroll.scrollTop, left: scroll.scrollLeft };
			restore = () => { if (current()) { scroll.scrollTop = before.top; scroll.scrollLeft = before.left; } };
			for (let attempt = 0; !handle && attempt < 3 && "file" in target; attempt++) {
				if (!current()) return "unavailable";
				const position = this.position(target.file, target.type === "cell" ? target.property : undefined);
				if (!position || !callable(this.renderer.updateVirtualDisplay)) break;
				scroll.scrollTop = position.top; if (position.left !== undefined) scroll.scrollLeft = position.left;
				this.renderer.updateVirtualDisplay(true); await frame();
				if (!current()) return "unavailable";
				handle = this.handles().find(item => sameTarget(item.target, target));
			}
			if (!handle || !handle.current()) {
				restore();
				return "unavailable";
			}
			if (!current()) return "unavailable";
			handle.element.scrollIntoView({ block: "nearest", inline: "nearest" });
			return "revealed";
		} catch { try { restore?.(); } catch { /* A removed native view cannot be restored. */ } return "unavailable"; }
	}
}
