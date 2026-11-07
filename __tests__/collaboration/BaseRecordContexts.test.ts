import { baseRecordIds, parseBaseRecordContexts } from "../../src/collaboration/BaseRecordContexts";
import { DiscussionTransport } from "../../src/collaboration/DiscussionTransport";
import { baseDiscussionScope } from "../../src/collaboration/DiscussionScope";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const value = { protocol_version: 1, entry_id: id(3), view_id: id(4), definition_id: id(5), generation: id(6), registry_revision: 2,
	records: [{ record_id: id(20), record_generation: id(21) }, { record_id: id(22), record_generation: null }] };

test("record proof requires a bounded complete identity set and discards unrelated response data", () => {
	expect(parseBaseRecordContexts({ ...value, private_path: "ignored" }, id(3), id(4), [id(22), id(20)])).toEqual(value);
	for (const records of [value.records.slice(0, 1), [value.records[0], value.records[0]],
		[value.records[0], { record_id: id(23), record_generation: null }],
		[value.records[0], { record_id: id(22), record_generation: "a filename" }]]) {
		expect(() => parseBaseRecordContexts({ ...value, records }, id(3), id(4), [id(20), id(22)])).toThrow();
	}
	for (const ids of [[], [id(20), id(20)], ["file.md"], Array.from({ length: 101 }, (_, n) => id(n))]) expect(() => baseRecordIds(ids)).toThrow();
	expect(() => parseBaseRecordContexts(value, id(3), id(99), [id(20), id(22)])).toThrow();
});

test("transport sends one sensitive scoped request and rejects incomplete server batches", async () => {
	const fetcher = jest.fn().mockResolvedValue(new Response(JSON.stringify(value)));
	const transport = new DiscussionTransport({ serverId: "https://relay.test", accountId: id(1), shareId: id(2) },
		async () => ({ accountId: id(1), accessToken: "synthetic-token" }), fetcher);
	const scope = baseDiscussionScope(id(3), id(4));
	expect(await transport.baseRecordContexts(scope, id(4), [id(22), id(20)])).toEqual(value);
	expect(fetcher).toHaveBeenCalledTimes(1);
	expect(fetcher.mock.calls[0][0]).toMatch(/\/bases\/record-contexts$/);
	expect(fetcher.mock.calls[0][1]).toMatchObject({ method: "POST", sensitive: true });
	expect(JSON.parse(fetcher.mock.calls[0][1].body)).toEqual({ view_id: id(4), record_ids: [id(20), id(22)] });
	fetcher.mockResolvedValue(new Response(JSON.stringify({ ...value, records: [] })));
	await expect(transport.baseRecordContexts(scope, id(4), [id(20)])).rejects.toMatchObject({ code: "invalid_read_response" });
});
