/**
 * # SettingsPersistence
 *
 * The plugin persists everything into a single JSON blob (Obsidian's
 * `data.json`). This module gives every component a namespaced *view* into
 * that blob instead of having each one read/write the raw object directly:
 *
 *   - `Settings<T>` owns the load/save round-trip against a storage adapter
 *     (Obsidian's plugin data file, or an in-memory stub for tests) and
 *     fans out change notifications.
 *   - `SettingsScope<T>` is a read/write lens onto one path inside that
 *     blob — `"login"`, `"endpoints"`, `"sharedFolders/[guid=abc]"`, etc. —
 *     so a component only ever sees (and can only write) its own slice.
 *
 * ## Namespace syntax
 *
 * A namespace is a `/`-separated list of segments. Each segment is either:
 *
 *   - a plain key (`"login"`, `"folders"`) — walks straight into the object;
 *   - `[key=value]` — selects the array element whose `key` field equals
 *     `value` (e.g. `"folders/[id=123]"` finds `{id: "123", ...}` inside the
 *     `folders` array, creating it if it isn't there yet);
 *   - `(glob)` — when it is the ONLY segment in the namespace, exposes every
 *     top-level key matching the glob as its own flat object instead of
 *     descending into a nested key (e.g. `"(enable*)"` surfaces every
 *     `enableSomething` flag at the root).
 *
 * See `__tests__/TestSettingsBackend.ts` for worked examples of each form.
 */

import { Notifier, type Unsubscriber } from "./notifiers/Notifier";

export type KeyStep = string | number;
export type Path = KeyStep[];

export class SettingsAccessError extends Error {
	constructor(
		message: string,
		public readonly path?: string,
	) {
		super(message);
		this.name = "SettingsAccessError";
	}
}

export interface PluginDataFile<T> {
	loadData(): Promise<T | null>;
	saveData(data: T): Promise<void>;
}

/**
 * Owns the load/save round-trip for the whole settings blob and notifies
 * subscribers (typically `SettingsScope` instances) whenever it
 * changes. Doesn't understand namespaces at all — that's layered on top by
 * `SettingsScope`.
 */
export class Settings<T> extends Notifier<T> {
	private currentValue: T;
	private hydrated = false;

	constructor(
		private readonly backend: PluginDataFile<T>,
		private readonly defaultValue: T,
	) {
		super("Settings");
		this.currentValue = { ...defaultValue };
	}

	async hydrate(): Promise<void> {
		const onDisk = await this.backend.loadData();
		// Shallow merge: any field present in the stored blob wins, anything
		// missing (new field, or a legacy record from before it existed)
		// falls back to its default. This is the on-disk-compatibility
		// contract — don't deep-merge, don't drop unrecognized fields.
		this.currentValue = { ...this.defaultValue, ...(onDisk ?? {}) };
		this.hydrated = true;
		this.log("settings loaded from disk:", this.currentValue);
	}

	async persist(): Promise<void> {
		if (!this.hydrated) {
			this.warn("save requested before initial load completed");
			return;
		}
		this.log("writing settings to disk:", this.currentValue);
		await this.backend.saveData(this.currentValue);
	}

	snapshot(): T {
		return this.currentValue;
	}

	/** Read persisted state without overwriting the current in-memory settings.
	 * Recovery uses this to reconcile a save whose acknowledgement was lost. */
	async persistedSnapshot(): Promise<T> {
		if (!this.hydrated) throw new Error("Settings must be loaded before inspecting persisted state");
		const onDisk = await this.backend.loadData();
		return { ...this.defaultValue, ...(onDisk ?? {}) };
	}

	async mutate(updater: (current: T) => T): Promise<void> {
		if (!this.hydrated) {
			this.warn("update requested before initial load completed");
			return;
		}
		const current = this.currentValue;
		const updated = updater(current);
		const changed = JSON.stringify(current) !== JSON.stringify(updated);
		// Assign in-memory state synchronously, BEFORE the disk round-trip
		// below. Load-bearing: a caller that fires mutate() without
		// awaiting it (a pre-existing, otherwise-safe pattern — e.g.
		// VaultShare's `wantsConnection` setter) and then synchronously
		// reads snapshot() right after used to see the PRE-update value,
		// because this used to assign `this.currentValue` only after
		// `await this.backend.loadData()` resolved. Two such fire-and-forget
		// calls issued back to back could even race each other, with
		// whichever one's disk round-trip resolved second silently
		// clobbering the other's in-memory write ( — a settings
		// array-item write issued right after an unawaited node-creation
		// update lost the node's freshly-created fields this way).
		this.currentValue = updated;
		if (changed) this.notifySubscribers();
		const onDisk = await this.backend.loadData();
		if (JSON.stringify(updated) === JSON.stringify(onDisk)) {
			this.debug("update produced no diff against disk, skipping write");
			return;
		}
		await this.persist();
	}

	override notifySubscribers(): void {
		for (const listener of this._listeners) listener(this.currentValue);
	}
}

type PlainObject = Record<string, unknown>;

/** One segment of a compiled namespace path. `index` is this step's position in the path, needed to slice off "everything after this pattern". */
type NamespaceStep =
	| { readonly kind: "field"; readonly navKey: string; readonly index: number }
	| {
			readonly kind: "arrayItem";
			readonly navKey: string;
			readonly matchKey: string;
			readonly matchValue: string;
			readonly index: number;
	  }
	| { readonly kind: "wildcard"; readonly navKey: string; readonly regex: RegExp; readonly index: number };

/** Parses `"folders/[id=123]/(enable*)"` into raw tokens + a walk plan. */
function compileNamespace(namespace: string): { tokens: string[]; steps: NamespaceStep[] } {
	if (!namespace) {
		throw new SettingsAccessError("namespace path must not be empty");
	}
	if (namespace.startsWith("/") || namespace.endsWith("/")) {
		throw new SettingsAccessError(`Invalid path format: ${namespace}`);
	}

	const tokens = namespace.split("/").filter((segment) => segment.length > 0);
	const steps: NamespaceStep[] = [];

	tokens.forEach((token, index) => {
		const arrayItem = token.match(/^\[(\w+)=(.+)\]$/);
		const wildcard = token.match(/^\((.+?)\)$/);

		if (arrayItem) {
			const [, matchKey, matchValue] = arrayItem;
			const navKey = index > 0 ? steps[index - 1].navKey : token.split("[")[0];
			steps.push({ kind: "arrayItem", navKey, matchKey, matchValue, index });
		} else if (wildcard) {
			const source = wildcard[1].replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace("\\*", ".*");
			steps.push({ kind: "wildcard", navKey: token, regex: new RegExp(`^${source}$`), index });
		} else {
			steps.push({ kind: "field", navKey: token, index });
		}
	});

	return { tokens, steps };
}

/** `namespace` is exactly one wildcard segment (`"(enable*)"`) — the only case that reads/writes a flat filtered slice instead of descending. */
function soleWildcard(steps: readonly NamespaceStep[]): Extract<NamespaceStep, { kind: "wildcard" }> | undefined {
	return steps.length === 1 && steps[0].kind === "wildcard" ? steps[0] : undefined;
}

function readByWildcardFilter(root: PlainObject, regex: RegExp): PlainObject {
	const filtered: PlainObject = {};
	for (const [key, value] of Object.entries(root)) {
		if (regex.test(key)) filtered[key] = value;
	}
	return filtered;
}

function writeByWildcardFilter(root: PlainObject, regex: RegExp, value: PlainObject): PlainObject {
	const result = { ...root };
	for (const [key, val] of Object.entries(value)) {
		if (regex.test(key)) result[key] = val;
	}
	return result;
}

/**
 * A namespaced, reactive lens onto a slice of a `Settings<Parent>` blob.
 * Reads/writes are addressed by the pattern language documented at the top
 * of this file; `subscribe()`/`notifySubscribers()` fire only when this
 * namespace's own slice actually changed.
 */
export class SettingsScope<
	T extends object,
	Parent extends object = Record<string, unknown>,
> extends Notifier<T> {
	private readonly tokens: string[];
	private readonly steps: NamespaceStep[];
	private teardown?: Unsubscriber;
	private lastSeen?: T;

	constructor(
		public readonly parentSettings: Settings<unknown>,
		namespace: string,
	) {
		super(`SettingsScope[${namespace}]`);
		const compiled = compileNamespace(namespace);
		this.tokens = compiled.tokens;
		this.steps = compiled.steps;
		this.lastSeen = this.read(this.parentSettings.snapshot() as PlainObject);
		this.teardown = this.parentSettings.subscribe(() => {
			const next = this.read(this.parentSettings.snapshot() as PlainObject);
			if (this.lastSeen === undefined && next === undefined) return;
			if (JSON.stringify(this.lastSeen) !== JSON.stringify(next)) {
				this.lastSeen = next;
				this.notifySubscribers();
			}
		});
	}

	private requireLive(): void {
		if (this.destroyed) {
			throw new SettingsAccessError("settings instance was already destroyed", this.scopePath());
		}
	}

	destroy(): void {
		if (this.destroyed) return;
		this.teardown?.();
		this.teardown = undefined;
		this._listeners.clear();
		this.destroyed = true;
	}

	/**
	 * The first step in namespace order that carries a pattern (array-item
	 * or wildcard), if any — mirrors the original's "only the leading
	 * pattern gets special read handling" rule (a pattern buried later in
	 * the path degrades to a literal key on the read path).
	 */
	private firstPatternStep(): NamespaceStep | undefined {
		return this.steps.find((s) => s.kind !== "field");
	}

	/** Any array-item step present anywhere — the write/delete paths support exactly one, always keyed off `steps[0].navKey` as the container. */
	private anyArrayStep(): Extract<NamespaceStep, { kind: "arrayItem" }> | undefined {
		return this.steps.find((s): s is Extract<NamespaceStep, { kind: "arrayItem" }> => s.kind === "arrayItem");
	}

	private read(root: PlainObject | null | undefined): T | undefined {
		const wildcard = soleWildcard(this.steps);
		if (wildcard) {
			return readByWildcardFilter(root ?? {}, wildcard.regex) as T;
		}

		const leading = this.firstPatternStep();
		if (leading?.kind === "arrayItem") {
			return this.readArrayItem(root, leading) as T | undefined;
		}

		let cursor: unknown = root;
		for (const step of this.steps) {
			if (!cursor) return undefined;
			cursor = (cursor as PlainObject)[step.navKey];
		}
		return cursor as T | undefined;
	}

	private readArrayItem(
		root: PlainObject | null | undefined,
		arrayStep: Extract<NamespaceStep, { kind: "arrayItem" }>,
	): unknown {
		// The container is always the very first path segment, regardless of
		// how deep `arrayStep` itself sits (matches the original's
		// `basePath[0]` — a namespace like "a/b/[id=1]" still reads `a`, not
		// `b`, as the array's parent key).
		const container = root?.[this.steps[0].navKey];
		if (!Array.isArray(container)) return undefined;

		const item = (container as PlainObject[]).find((entry) => entry[arrayStep.matchKey] === arrayStep.matchValue);
		if (!item) return undefined;

		const tailKeys = this.steps.slice(arrayStep.index + 1).map((s) => s.navKey);
		if (tailKeys.length === 0) return item;

		let cursor: unknown = item;
		for (const key of tailKeys) {
			if (!cursor || typeof cursor !== "object") return undefined;
			cursor = (cursor as PlainObject)[key];
		}
		return cursor;
	}

	readValue(): T {
		this.requireLive();
		const root = this.parentSettings.snapshot() as PlainObject | null | undefined;
		if (!root) return {} as T;
		const value = this.read(root);
		return value === undefined ? ({} as T) : value;
	}

	async writeValue(value: T): Promise<void> {
		this.requireLive();
		if (value === undefined) {
			throw new SettingsAccessError("refusing to store an undefined value", this.scopePath());
		}

		try {
			await this.parentSettings.mutate((rawRoot) => {
				const root = rawRoot as PlainObject;
				const wildcard = soleWildcard(this.steps);
				if (wildcard) {
					return writeByWildcardFilter(root, wildcard.regex, value as unknown as PlainObject);
				}
				return this.writeNested(root, value);
			});
		} catch (error: unknown) {
			const message = error instanceof Error ? error.message : "Unknown error";
			throw new SettingsAccessError(`Failed to set value at path ${this.scopePath()}: ${message}`, this.scopePath());
		}
	}

	private writeNested(root: PlainObject, value: T): PlainObject {
		const arrayStep = this.anyArrayStep();
		if (arrayStep) {
			return this.writeArrayItem(root, arrayStep, value);
		}

		const result = { ...root };
		let cursor = result;
		for (let i = 0; i < this.steps.length - 1; i++) {
			const key = this.steps[i].navKey;
			cursor[key] = cursor[key] || {};
			cursor = cursor[key] as PlainObject;
		}
		cursor[this.steps[this.steps.length - 1].navKey] = value;
		return result;
	}

	private writeArrayItem(
		root: PlainObject,
		arrayStep: Extract<NamespaceStep, { kind: "arrayItem" }>,
		value: T,
	): PlainObject {
		const result = { ...root };
		const containerKey = this.steps[0].navKey;
		if (!result[containerKey]) result[containerKey] = [];
		const items = result[containerKey] as PlainObject[];

		const tailKeys = this.steps.slice(arrayStep.index + 1).map((s) => s.navKey);
		const index = items.findIndex((entry) => entry[arrayStep.matchKey] === arrayStep.matchValue);

		if (index >= 0) {
			if (tailKeys.length > 0) {
				let cursor = items[index];
				for (let i = 0; i < tailKeys.length - 1; i++) {
					cursor[tailKeys[i]] = cursor[tailKeys[i]] || {};
					cursor = cursor[tailKeys[i]] as PlainObject;
				}
				cursor[tailKeys[tailKeys.length - 1]] = value;
			} else {
				items[index] = {
					...items[index],
					...(value as unknown as PlainObject),
					[arrayStep.matchKey]: arrayStep.matchValue,
				};
			}
			return result;
		}

		if (tailKeys.length > 0) {
			const created: PlainObject = { [arrayStep.matchKey]: arrayStep.matchValue };
			let cursor = created;
			for (let i = 0; i < tailKeys.length - 1; i++) {
				cursor[tailKeys[i]] = {};
				cursor = cursor[tailKeys[i]] as PlainObject;
			}
			cursor[tailKeys[tailKeys.length - 1]] = value;
			items.push(created);
		} else {
			items.push({ ...(value as unknown as PlainObject), [arrayStep.matchKey]: arrayStep.matchValue });
		}
		return result;
	}

	async mutateValue(updater: (current: T) => T, force = false): Promise<void> {
		this.requireLive();
		const current = this.readValue();
		const updated = updater(current);
		if (!force && JSON.stringify(current) === JSON.stringify(updated)) return;
		await this.writeValue(updated);
	}

	/** Inspect the saved namespace without hydrating or changing other settings. */
	async readPersistedValue(): Promise<T | undefined> {
		this.requireLive(); const snapshot = await this.parentSettings.persistedSnapshot(); this.requireLive();
		return this.read(snapshot as PlainObject);
	}

	/** Re-applies the current value through `mutateValue()`, forcing a change notification even if nothing changed. */
	async forceNotify(): Promise<void> {
		this.requireLive();
		await this.mutateValue((current) => current, true);
	}

	parentScope(): SettingsScope<Parent> {
		this.requireLive();
		return new SettingsScope<Parent>(this.parentSettings, this.tokens.slice(0, -1).join("/"));
	}

	childScope<
		C extends Record<string, unknown>,
		R extends SettingsScope<C> = SettingsScope<C>,
	>(childPath: string, factory?: (settings: Settings<unknown>, path: string) => R): R {
		const fullPath = [...this.tokens, childPath].join("/");
		if (factory) return factory(this.parentSettings, fullPath);
		this.log("childScope", this.tokens, childPath, fullPath, this.steps);
		return new SettingsScope<C>(this.parentSettings, fullPath) as R;
	}

	scopePath(): string {
		return this.tokens.join("/");
	}

	hasValue(): boolean {
		this.requireLive();
		return this.read(this.parentSettings.snapshot() as PlainObject) !== undefined;
	}

	async delete(): Promise<void> {
		this.requireLive();
		await this.parentSettings.mutate((rawRoot) => {
			const result = { ...(rawRoot as PlainObject) };
			const arrayStep = this.anyArrayStep();

			if (arrayStep) {
				const containerKey = this.steps[0].navKey;
				if (Array.isArray(result[containerKey])) {
					const remaining = (result[containerKey] as PlainObject[]).filter(
						(entry) => entry[arrayStep.matchKey] !== arrayStep.matchValue,
					);
					if (remaining.length === 0) {
						delete result[containerKey];
					} else {
						result[containerKey] = remaining;
					}
				}
				return result;
			}

			let cursor = result;
			for (const step of this.steps.slice(0, -1)) {
				if (!cursor[step.navKey]) return result;
				cursor = cursor[step.navKey] as PlainObject;
			}
			delete cursor[this.steps[this.steps.length - 1].navKey];
			return result;
		});
	}

	subscribe(run: (value: T) => void): Unsubscriber {
		this.requireLive();
		this._listeners.add(run);
		run(this.readValue());
		return () => this._listeners.delete(run);
	}

	override notifySubscribers(): void {
		if (this.destroyed) return;
		const value = this.readValue();
		for (const listener of this._listeners) listener(value);
	}
}
