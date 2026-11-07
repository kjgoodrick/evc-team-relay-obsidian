import { TFile } from "obsidian";
import { BasePresenceRecords, type BaseLocalRecord } from "../../src/collaboration/presence/BasePresenceRecords";
import type { BaseRecordContext } from "../../src/collaboration/presence/BasePositionProtocol";
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const file = (n = 1): TFile => Object.assign(Object.create(TFile.prototype), { path: `${n}.md` });
const context = (n = 1, generation = 2): BaseRecordContext => ({ protocol_version: 1, share_id: id(3), entry_id: id(n), generation: id(generation), type: "markdown" });
const tick = async () => { for (let n = 0; n < 8; n++) await Promise.resolve(); };
function fixture() {
	const f = file(); let permitted = true, active = true;
	const local = jest.fn((value: TFile): BaseLocalRecord | undefined => permitted ? { id: id(Number(value.path.split(".")[0])), type: "markdown" } : undefined);
	const read = jest.fn(async () => context()), changed = jest.fn();
	const records = new BasePresenceRecords({ current: () => active, local, read, changed });
	return { f, local, read, changed, records, permit: (value: boolean) => { permitted = value; }, active: (value: boolean) => { active = value; } };
}

test("metadata is reused through movement and unrelated inventory reconciliation", async () => {
	const f = fixture();
	try {
		expect(f.records.get(f.f)).toBeUndefined(); await tick();
		for (let n = 0; n < 1000; n++) expect(f.records.get(f.f)).toEqual(context());
		f.records.reconcile(); expect(await f.records.wait(f.f, id(2))).toEqual(context()); expect(f.read).toHaveBeenCalledTimes(1);
		f.f.path = "4.md"; expect(f.records.get(f.f)).toBeUndefined(); await tick(); expect(f.read).toHaveBeenCalledTimes(2);
	} finally { f.records.close(); }
});

test("rejections never poll and explicit retry can restore lineage", async () => {
	const f = fixture();
	try {
		f.read.mockRejectedValueOnce(new Error("denied")); f.records.get(f.f); await tick();
		for (let n = 0; n < 100; n++) expect(f.records.get(f.f)).toBeUndefined(); await tick(); expect(f.read).toHaveBeenCalledTimes(1);
		f.records.reset(); expect(await f.records.wait(f.f, id(2))).toEqual(context()); expect(f.read).toHaveBeenCalledTimes(2);
	} finally { f.records.close(); }
});

test("a new advertised generation refreshes once and stale advertised generations do not poll", async () => {
	const f = fixture();
	try {
		expect(await f.records.wait(f.f, id(2))).toEqual(context()); f.read.mockResolvedValueOnce(context(1, 4));
		expect(f.records.get(f.f, id(4))).toBeUndefined(); await tick(); expect(f.records.get(f.f, id(4))).toEqual(context(1, 4));
		f.read.mockResolvedValue(context(1, 4)); f.records.get(f.f, id(5)); await tick();
		for (let n = 0; n < 100; n++) expect(f.records.get(f.f, id(5))).toBeUndefined(); await tick(); expect(f.read).toHaveBeenCalledTimes(3);
	} finally { f.records.close(); }
});

test.each(["permission", "identity", "close", "account"])("late metadata cannot restore a stale %s record", async loss => {
	const f = fixture(); let finish!: (value: BaseRecordContext) => void;
	try {
		f.read.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; })); const pending = f.records.wait(f.f, id(2)); await tick();
		if (loss === "permission") f.permit(false); if (loss === "identity") f.f.path = "9.md"; if (loss === "close") f.records.close(); if (loss === "account") f.active(false);
		finish(context()); expect(await pending).toBeUndefined(); expect(f.changed).not.toHaveBeenCalled();
	} finally { f.records.close(); }
});

test("request concurrency and queued metadata are bounded, and reset releases pending waiters", async () => {
	const f = fixture(), finishes: ((value: BaseRecordContext) => void)[] = [];
	try {
		f.read.mockImplementation(() => new Promise(resolve => finishes.push(resolve)));
		const first = f.records.wait(file(1), id(2));
		for (let n = 2; n <= 300; n++) f.records.get(file(n)); await tick(); expect(f.read).toHaveBeenCalledTimes(2);
		expect(await first).toBeUndefined(); // Evicted from the bounded metadata queue.
		f.records.reset(); finishes.forEach(finish => finish(context())); await tick(); expect(f.read).toHaveBeenCalledTimes(2); expect(f.changed).not.toHaveBeenCalled();
	} finally { f.records.close(); }
});
