import { TFile } from "obsidian";
import { createHash } from "node:crypto";
import { BasePresenceGroups } from "../../src/collaboration/presence/BasePresenceGroups";
import { BasePresenceRecords } from "../../src/collaboration/presence/BasePresenceRecords";
import type { BaseRecordContext } from "../../src/collaboration/presence/BasePositionProtocol";
import type { NativeBaseGroupHandle, NativeBasesSurface } from "../../src/bases/NativeBasesSurface";
import type { BaseLocation } from "../../src/collaboration/presence/LocationProtocol";
import { sha256Hex } from "../../src/contentDigest";

jest.mock("../../src/contentDigest", () => ({ sha256Hex: jest.fn(async (bytes: ArrayBuffer) => createHash("sha256").update(new Uint8Array(bytes)).digest("hex")) }));
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const flush = async () => { for (let n = 0; n < 40; n++) await Promise.resolve(); };
function fixture() {
	const files = [1, 2, 3].map(n => Object.assign(Object.create(TFile.prototype), { path: `Team/Sub/${n}.md` }));
	let location: BaseLocation = { kind: "base", share_id: id(10), entry_id: id(11), generation: id(12), definition_id: id(13), view_id: id(14), registry_revision: 1 };
	const denied = new Set<TFile>(); let active = true, supported = true, members = files.slice(0, 2);
	const local = (file: TFile) => files.includes(file) && !denied.has(file) ? { id: id(files.indexOf(file) + 1), type: "markdown" as const, path: `Sub/${files.indexOf(file) + 1}.md` } : undefined;
	const read = jest.fn(async (entry: string): Promise<BaseRecordContext> => ({ protocol_version: 1, share_id: id(10), entry_id: entry, generation: id(Number(entry.slice(-12)) + 20), type: "markdown" }));
	const current = () => active;
	const records = new BasePresenceRecords({ current, local, read, changed: jest.fn() });
	const handle: NativeBaseGroupHandle = { target: { type: "group", property: { source: "note", name: "status" }, value: { type: "text", value: "Done" } }, element: {} as HTMLElement, ambiguous: false, current, members: () => members };
	let handles = [handle]; const surface = { current, groupHandles: () => handles } as unknown as NativeBasesSurface;
	const changed = jest.fn(), groups = new BasePresenceGroups({ current, supported: () => supported, location: () => location, local,
		file: record => files.find(file => local(file)?.id === record), fileAtPath: path => files.find(file => file.path === path) ?? null, resolve: () => null, records, changed });
	const capture = () => groups.capture(groups.frame(surface), handle);
	const target = async () => { let value = capture(); for (let n = 0; !value && n < 10; n++) { await flush(); value = capture(); } if (!value) throw new Error("No captured group"); return value; };
	return { files, location, denied, local, read, records, handle, surface, changed, groups, capture, target,
		members: (value: TFile[]) => { members = value; }, handles: (value: NativeBaseGroupHandle[]) => { handles = value; },
		scope: (view: string) => { location = { ...location, view_id: view }; },
		active: (value: boolean) => { active = value; }, supported: (value: boolean) => { supported = value; }, close: () => { groups.close(); records.close(); } };
}

test("typed capture never publishes labels and reuses hashes/metadata through ordinary movement and repaint", async () => {
	const f = fixture();
	try {
		const target = await f.target(), hashes = jest.mocked(sha256Hex).mock.calls.length, reads = f.read.mock.calls.length;
		expect(target).toMatchObject({ type: "group", record_id: id(1), record_generation: id(21), references: [] });
		expect(JSON.stringify(target)).not.toMatch(/Done|Team|Sub/);
		for (let n = 0; n < 1000; n++) expect(f.capture()).toEqual(target);
		expect(jest.mocked(sha256Hex).mock.calls).toHaveLength(hashes); expect(f.read).toHaveBeenCalledTimes(reads);
		expect(f.groups.project(f.groups.frame(f.surface), target)?.current()).toBe(true);
		f.handle.target.value = { type: "number", value: 1 }; const number = await f.target();
		f.handle.target.value = { type: "text", value: "1" }; expect((await f.target()).value_sha256).not.toBe(number.value_sha256);
		f.scope(id(99)); expect((await f.target()).value_sha256).not.toBe(target.value_sha256);
	} finally { f.close(); }
});

test("links require every current input, exact dependencies and member identity", async () => {
	const f = fixture();
	try {
		f.handle.target.value = { type: "link", file: f.files[2], subpath: "#Heading" };
		const target = await f.target(); expect(target.references).toEqual([{ record_id: id(3), record_generation: id(23) }]);
		expect(f.groups.project(f.groups.frame(f.surface), { ...target, references: [] })).toBeUndefined();
		const match = f.groups.project(f.groups.frame(f.surface), target)!;
		f.denied.add(f.files[2]); expect(match.current()).toBe(false); expect(f.capture()).toBeUndefined();
		f.records.reconcile(); f.denied.clear(); expect(await f.target()).toEqual(target);
		f.members([f.files[1]]); expect(f.groups.project(f.groups.frame(f.surface), target)).toBeUndefined();
		expect((await f.target()).record_id).toBe(id(2));
	} finally { f.close(); }
});

test.each(["path", "folder"])("file.%s matching is stable across different vault mount prefixes", async name => {
	const a = fixture(), b = fixture();
	try {
		for (const f of [a, b]) { f.handle.target.property = { source: "file", name }; f.members([f.files[0]]); }
		b.files[0].path = "Other/Shared/Sub/1.md";
		for (const f of [a, b]) f.handle.target.value = { type: "text", value: name === "path" ? f.files[0].path : f.files[0].path.slice(0, f.files[0].path.lastIndexOf("/")) };
		const target = await a.target(); expect(await b.target()).toEqual(target); expect(b.groups.project(b.groups.frame(b.surface), target)?.current()).toBe(true);
		b.handle.target.value = { type: "text", value: "stale/path" }; expect(b.capture()).toBeUndefined();
	} finally { a.close(); b.close(); }
});

test("unresolved links use canonical source paths and reject unreadable source documents", async () => {
	const a = fixture(), b = fixture();
	try {
		b.files[2].path = "Different/Sub/3.md";
		for (const f of [a, b]) f.handle.target.value = { type: "unresolved_link", source: f.files[2].path, link: "Missing#Heading" };
		const target = await a.target(); expect(await b.target()).toEqual(target);
		expect(target.references).toEqual([{ record_id: id(3), record_generation: id(23) }]);
		b.denied.add(b.files[2]); expect(b.capture()).toBeUndefined();
	} finally { a.close(); b.close(); }
});

test("ambiguous/duplicate headers, unsupported groups and excessive dependencies never guess", async () => {
	const f = fixture();
	try {
		f.handle.ambiguous = true; expect(f.capture()).toBeUndefined(); f.handle.ambiguous = false;
		f.handles([f.handle, { ...f.handle }]); expect(f.capture()).toBeUndefined(); f.handles([f.handle]);
		f.handle.target.property.source = "formula"; expect(f.capture()).toBeUndefined(); f.handle.target.property.source = "note";
		f.supported(false); expect(f.capture()).toBeUndefined(); f.supported(true);
		f.handle.target.value = { type: "list", value: Array.from({ length: 10 }, (_, n) => ({ type: "file", file: Object.assign(Object.create(TFile.prototype), { path: `${n}.md` }) })) };
		expect(f.capture()).toBeUndefined(); expect(f.read).not.toHaveBeenCalled();
	} finally { f.close(); }
});

test("late metadata/hash results cannot restore a closed or revoked group", async () => {
	const f = fixture(); let finish!: (value: BaseRecordContext) => void;
	try {
		f.members([f.files[0]]); f.read.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
		expect(f.capture()).toBeUndefined(); await flush(); f.active(false);
		finish({ protocol_version: 1, share_id: id(10), entry_id: id(1), generation: id(21), type: "markdown" }); await flush(); expect(f.capture()).toBeUndefined();
		f.close(); expect(f.groups.frame(f.surface).handles).toEqual([]);
	} finally { f.close(); }
});

test("hash jobs have bounded concurrency and close discards pending work while stale work finishes", async () => {
	const f = fixture(), hash = jest.mocked(sha256Hex), original = hash.getMockImplementation()!;
	const pending: (() => void)[] = []; let running = 0, maximum = 0;
	try {
		await f.target(); f.groups.reset(); f.members([f.files[0]]);
		hash.mockImplementation(bytes => new Promise(resolve => { running++; maximum = Math.max(maximum, running); pending.push(() => { running--; void original(bytes).then(resolve); }); }));
		for (let n = 0; n < 160; n++) { f.handle.target.value = { type: "text", value: `Status ${n}` }; f.capture(); await flush(); }
		expect(maximum).toBe(2); expect(pending).toHaveLength(2);
		const changeCount = f.changed.mock.calls.length; f.close(); pending.splice(0).forEach(finish => finish()); await flush();
		expect(f.changed).toHaveBeenCalledTimes(changeCount); expect(running).toBe(0); expect(pending).toHaveLength(0);
	} finally { hash.mockImplementation(original); f.close(); }
});

test("target mismatch, generation refresh and a delayed hash cannot authorize stale navigation", async () => {
	const f = fixture(), hash = jest.mocked(sha256Hex), original = hash.getMockImplementation()!;
	let finish!: () => void;
	try {
		const target = await f.target(); f.members([f.files[0]]);
		expect(await f.groups.wait(f.surface, { ...target, value_sha256: "b".repeat(64) }, () => true)).toBeUndefined();
		f.groups.reset(); hash.mockImplementation(bytes => new Promise(resolve => { finish = () => { void original(bytes).then(resolve); }; }));
		let current = true; const navigation = f.groups.wait(f.surface, target, () => current); await flush(); expect(finish).toBeDefined();
		current = false; f.groups.reset(); expect(await navigation).toBeUndefined(); finish(); await flush();
		hash.mockImplementation(original);
		f.read.mockImplementation(async entry => ({ protocol_version: 1, share_id: id(10), entry_id: entry, generation: id(90), type: "markdown" }));
		f.records.reset(); expect(await f.groups.wait(f.surface, target, () => true)).toBeUndefined();
	} finally { hash.mockImplementation(original); f.close(); }
});
