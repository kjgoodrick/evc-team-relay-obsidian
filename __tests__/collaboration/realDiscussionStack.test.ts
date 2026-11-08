import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { DiscussionTransport } from "../../src/collaboration/DiscussionTransport";
import { DiscussionOutbox } from "../../src/collaboration/DiscussionOutbox";
import { DiscussionSync, messageKey, threadKey } from "../../src/collaboration/DiscussionSync";
import { DiscussionStore, type Json, type QueuedCommand } from "../../src/collaboration/storage/DiscussionStore";
import { DiscussionSession } from "../../src/collaboration/DiscussionSession";
import { protocolJson, type MessageBody } from "../../src/collaboration/DiscussionProtocol";
import { EditorState } from "prosemirror-state";
import { bodyToCommentDoc, commentDocBody, richCommentBody } from "../../src/collaboration/ui/RichCommentModel";
import { PermissionPolicyClient } from "../../src/collaboration/PermissionPolicy";
import { applyPermissionOverrides, permissionChanges } from "../../src/collaboration/PermissionEditor";
import { editableCommentDraft } from "../../src/collaboration/ui/CommentDraft";
import { bodyFromText } from "../../src/collaboration/DiscussionProtocol";

const fixturePath = process.env.EVC_DISCUSSION_FIXTURE;
const integration = fixturePath ? test : test.skip;
Object.assign(globalThis, { IDBKeyRange });


integration("real HTTP commands recover lost replies, persist history/reactions, and recheck comment revocation", async () => {
	const fixture = JSON.parse(readFileSync(fixturePath!, "utf8")) as {
		base: string; share: string; entry: string; reviewer: string; token: string; ownerToken: string;
	};
	if (new URL(fixture.base).hostname !== "127.0.0.1") throw new Error("Only a disposable loopback server is allowed");
	const identity = { serverId: fixture.base, accountId: fixture.reviewer, shareId: fixture.share, vaultId: "synthetic-vault" };
	const store = await DiscussionStore.open(identity, new IDBFactory());
	let time = Date.now(), lostResponse = true;
	const fetcher = jest.fn(async (url: string, config: RequestInit) => {
		const response = await fetch(url, config);
		if (lostResponse && response.ok && config.method === "POST") { lostResponse = false; await response.text(); throw new Error("Lost accepted response"); }
		return response;
	});
	const transport = new DiscussionTransport(identity, async () => ({ accountId: fixture.reviewer, accessToken: fixture.token }), fetcher);
	const worker = new DiscussionOutbox(store, transport, "integration-worker", undefined, () => time, () => 0.5);
	const incoming = new DiscussionSync(store, transport, fixture.entry);
	let historySession: DiscussionSession | undefined;
	let stopHistory: (() => void) | undefined;
	const body = (text: string) => ({ version: 1, blocks: [{ type: "paragraph", children: [{ type: "text", text }] }] });
	const thread = randomUUID(), message = randomUUID(), root = randomUUID();
	const enqueue = (type: QueuedCommand["type"], payload: Json, dependsOn: string[] = [], operationId = randomUUID()) =>
		store.enqueue({ operationId, scopeId: fixture.entry, type, payload, dependsOn }, time);
	const api = async (path: string, options: RequestInit = {}, owner = false) => {
		const response = await fetch(fixture.base + "/v1/collaboration/" + path, { ...options,
			headers: { "Content-Type": "application/json", Authorization: `Bearer ${owner ? fixture.ownerToken : fixture.token}` } });
		expect(response.status).toBe(200); return response.json();
	};
	const scopePath = `shares/${fixture.share}/entries/${fixture.entry}`;
	try {
		expect(await transport.capabilities()).toMatchObject({ discussions: true, textAnchors: false, blockAnchors: false, imageOccurrences: false, imageFiles: false, pictures: false, recovery: true, search: false });
		expect(await transport.permissions(fixture.entry)).toEqual({ read: true, comment: true, edit: false, moderate: false });
		expect((await transport.participants(fixture.entry)).participants.map(person => person.name)).toEqual(expect.arrayContaining(["reviewer", "owner"]));
		await enqueue("thread.create", { type: "thread.create", thread_id: thread, message_id: message,
			anchor: { version: 1, type: "note" }, body: body("First") }, [], root);
		await enqueue("reply.create", { type: "reply.create", thread_id: thread, message_id: randomUUID(), body: body("Reply") }, [root]);
		worker.resume(); await worker.settled();
		expect((await store.getOperation(root))?.state).toBe("queued");
		time += 1001; worker.wake(); await worker.settled();
		expect((await store.getOperation(root))?.state).toBe("accepted");
		expect(fetcher.mock.calls.filter(([, config]) => config.method === "POST")).toHaveLength(3); // two root attempts, one dependent reply
		let view = await api(`${scopePath}/threads/${thread}`);
		expect(view.messages).toHaveLength(2); expect(view.messages[0].body.blocks[0].children[0].text).toBe("First");
		const edit = await enqueue("message.edit", { type: "message.edit", thread_id: thread, message_id: message,
			expected_revision: 1, body: body("Revised") });
		await enqueue("reaction.set", { type: "reaction.set", thread_id: thread, message_id: message, emoji: "heart", present: true });
		worker.wake(); await worker.settled();
		expect((await store.getOperation(edit.operationId))?.state).toBe("accepted");
		view = await api(`${scopePath}/threads/${thread}`);
		expect(view.messages[0]).toMatchObject({ revision: 2, reactions: [{ emoji: "heart", count: 1, mine: true }] });
		const history = await api(`${scopePath}/threads/${thread}/messages/${message}/history`);
		expect(history.revisions.map((r: { revision: number }) => r.revision)).toEqual([1, 2]);
		const changes = await api(`${scopePath}/changes`);
		expect(changes.events).toHaveLength(4); // duplicate retry produced no extra event
		expect(await transport.sendOnline({ operationId: randomUUID(), scopeId: fixture.entry, payload: {
			type: "thread.state", thread_id: thread, expected_state_revision: 1, state: "resolved",
		} })).toMatchObject({ state: "resolved", state_revision: 2 });
		const reopened = { operationId: randomUUID(), scopeId: fixture.entry, payload: {
			type: "reply.create", thread_id: thread, message_id: randomUUID(), body: body("Send and reopen"), reopen: true, expected_state_revision: 2,
		} };
		const acknowledged = await transport.sendOnline(reopened);
		expect(acknowledged).toMatchObject({ state: "open", state_revision: 3 });
		expect(await transport.sendOnline(reopened)).toEqual(acknowledged);
		incoming.resume(); await incoming.settled();
		expect(incoming.status).toBe("current");
		expect((await store.entity(fixture.entry, messageKey(thread, message)))?.value).toMatchObject({
			revision: 2, body: body("Revised"), reactions: [{ emoji: "heart", count: 1, mine: true }],
		});
		expect((await transport.history(fixture.entry, thread, message)).revisions.map(r => r.revision)).toEqual([1, 2]);
		historySession = new DiscussionSession(await DiscussionStore.open({ ...identity, vaultId: "synthetic-history" }, new IDBFactory()), transport);
		await historySession.start(); stopHistory = historySession.watch(fixture.entry, () => {}); await historySession.refresh();
		const latestHistory = await historySession.historyWindow(fixture.entry, thread, message);
		expect(latestHistory).toMatchObject({ latest: 2, selected: { revision: 2, body: body("Revised") }, previous: { revision: 1, body: body("First") } });
		expect(await historySession.historyWindow(fixture.entry, thread, message, 1)).toMatchObject({ latest: 2, selected: { revision: 1 } });
		expect((await transport.threads(fixture.entry)).threads).toHaveLength(1);
		expect((await transport.state(fixture.entry, thread)).thread.state).toBe("open");
		incoming.stop(); await incoming.settled();
		// The server commits this reply, but the response is lost. Revocation then
		// rejects its retry before receipt lookup; recovery must keep the same ID.
		lostResponse = true;
		const ambiguous = await enqueue("reply.create", { type: "reply.create", thread_id: thread, message_id: randomUUID(), body: body("Committed before access changed") });
		worker.wake(); await worker.settled();
		expect((await store.getOperation(ambiguous.operationId))?.state).toBe("queued");
		time += 1001;
		const rules = await api(`shares/${fixture.share}/comment-rules`, {}, true);
		await api(`shares/${fixture.share}/comment-rules`, { method: "PUT", body: JSON.stringify({
			expected_revision: rules.revision, rules: [{ user_id: fixture.reviewer, path: "", recursive: true, allowed: false }],
		}) }, true);
		const denied = await enqueue("reply.create", { type: "reply.create", thread_id: thread, message_id: randomUUID(), body: body("Keep my draft") });
		worker.wake(); await worker.settled();
		expect(await store.getOperation(denied.operationId)).toMatchObject({ state: "rejected", error: "comment_forbidden", payload: { body: body("Keep my draft") } });
		const ambiguousRejected = (await store.getOperation(ambiguous.operationId))!;
		expect(ambiguousRejected).toMatchObject({ state: "rejected", error: "comment_forbidden" });
		// Read-only receipt reconciliation is still available with note read
		// access. It cannot silently accept the local queue or resend unknown work.
		expect((await transport.capabilities()).commandStatus).toBe(true);
		expect(historySession.canCheckSavedCommand).toBe(true);
		expect(await historySession.checkSavedCommand(ambiguousRejected, () => true)).toMatchObject({ status: "accepted",
			result: { operation_id: ambiguous.operationId, message_id: (ambiguous.payload as Record<string, Json>).message_id } });
		expect(await historySession.checkSavedCommand(denied, () => true)).toEqual({ status: "unknown" });
		expect(await store.getOperation(ambiguous.operationId)).toMatchObject({ state: "rejected", error: "comment_forbidden" });
		expect(await store.getOperation(denied.operationId)).toMatchObject({ state: "rejected", error: "comment_forbidden" });
		expect(await store.entity(fixture.entry, messageKey(thread, message))).toBeUndefined();
		expect((await api(`${scopePath}/threads/${thread}`)).messages).toHaveLength(4);
		const revokedRules = await api(`shares/${fixture.share}/comment-rules`, {}, true);
		await api(`shares/${fixture.share}/comment-rules`, { method: "PUT", body: JSON.stringify({
			expected_revision: revokedRules.revision, rules: [{ user_id: fixture.reviewer, path: "", recursive: true, allowed: true }],
		}) }, true);
		expect(await store.retryRejected(ambiguous.operationId, fixture.entry, ambiguousRejected.attempt, time)).toBe(true);
		worker.wake(); await worker.settled();
		expect((await store.getOperation(ambiguous.operationId))?.state).toBe("accepted");
		expect((await api(`${scopePath}/threads/${thread}`)).messages).toHaveLength(4); // Manual retry recovered the original receipt.
		expect(await store.retryRejected(ambiguous.operationId, fixture.entry, ambiguousRejected.attempt, time)).toBe(false);
		await api("commands", { method: "POST", body: JSON.stringify({ protocol_version: 1, operation_id: randomUUID(),
			share_id: fixture.share, entry_id: fixture.entry, command: { type: "thread.remove", thread_id: thread,
				expected_state_revision: 3, reason: "Synthetic moderation" } }) }, true);
		incoming.resume(); await incoming.settled();
		expect(incoming.status).toBe("current");
		expect((await store.entity(fixture.entry, threadKey(thread)))?.value).toMatchObject({ removed: true });
		expect(await store.entity(fixture.entry, messageKey(thread, message))).toBeUndefined();
		expect((await store.getOperation(denied.operationId))?.payload).toMatchObject({ body: body("Keep my draft") });
		await expect(historySession.historyWindow(fixture.entry, thread, message)).rejects.toMatchObject({ status: 404 });
	} finally { stopHistory?.(); await historySession?.close(); worker.stop(); incoming.stop(); await Promise.all([worker.settled(), incoming.settled()]); store.close(); }
}, 30_000);

integration("rich live history retains structure and ordinary removal history is hidden even from its author/moderator", async () => {
	const fixture = JSON.parse(readFileSync(fixturePath!, "utf8")) as { base: string; share: string; entry: string; reviewer: string; owner: string; token: string; ownerToken: string };
	if (new URL(fixture.base).hostname !== "127.0.0.1") throw new Error("Only a disposable loopback server is allowed");
	const identity = { serverId: fixture.base, accountId: fixture.owner, shareId: fixture.share, vaultId: "history-owner" };
	const owner = new DiscussionTransport(identity, async () => ({ accountId: fixture.owner, accessToken: fixture.ownerToken }), fetch);
	const readerIdentity = { ...identity, accountId: fixture.reviewer, vaultId: "history-reader" };
	const reader = new DiscussionTransport(readerIdentity, async () => ({ accountId: fixture.reviewer, accessToken: fixture.token }), fetch);
	const authorSession = new DiscussionSession(await DiscussionStore.open(identity, new IDBFactory()), owner);
	const readerSession = new DiscussionSession(await DiscussionStore.open(readerIdentity, new IDBFactory()), reader);
	const stops: (() => void)[] = [];
	const thread = randomUUID(), message = randomUUID();
	const rich = (text: string): MessageBody => ({ version: 1, blocks: [
		{ type: "paragraph", children: [{ type: "text", text, marks: ["bold", "italic"] }, { type: "mention", user_id: fixture.reviewer },
			{ type: "link", url: "https://example.test/review", children: [{ type: "text", text: "Reference", marks: ["strike"] }] }] },
		{ type: "list", ordered: true, items: [{ type: "paragraph", children: [{ type: "text", text: "Item", marks: ["code"] }] }] },
		{ type: "code", text: "const safe = '<script>';", language: "ts" },
	] });
	try {
		// Serialize an actual local editor transaction, then verify both the
		// wire shape and the server's immutable revision/rejection behavior.
		const state = EditorState.create({ doc: bodyToCommentDoc(rich("Before"), () => "reviewer") });
		const edited = richCommentBody(commentDocBody(state.apply(state.tr.insertText("After", 1, 7)).doc));
		expect(edited).toEqual(rich("After"));
		await owner.send({ operationId: randomUUID(), scopeId: fixture.entry, type: "thread.create", dependsOn: [], payload: {
			type: "thread.create", thread_id: thread, message_id: message, anchor: { version: 1, type: "note" }, body: protocolJson(rich("Before")) } });
		await owner.send({ operationId: randomUUID(), scopeId: fixture.entry, type: "message.edit", dependsOn: [], payload: {
			type: "message.edit", thread_id: thread, message_id: message, expected_revision: 1, body: protocolJson(edited) } });
		await expect(owner.send({ operationId: randomUUID(), scopeId: fixture.entry, type: "message.edit", dependsOn: [], payload: {
			type: "message.edit", thread_id: thread, message_id: message, expected_revision: 1, body: protocolJson(rich("Stale overwrite")) } })).rejects.toMatchObject({ status: 409 });
		for (const session of [authorSession, readerSession]) { await session.start(); stops.push(session.watch(fixture.entry, () => {})); await session.refresh(); }
		expect(await readerSession.historyWindow(fixture.entry, thread, message)).toMatchObject({ latest: 2,
			selected: { revision: 2, body: rich("After") }, previous: { revision: 1, body: rich("Before") } });
		await owner.sendOnline({ operationId: randomUUID(), scopeId: fixture.entry, payload: {
			type: "message.delete", thread_id: thread, message_id: message, expected_revision: 2, reason: "Synthetic removal" } });
		for (const session of [readerSession, authorSession]) await expect(session.historyWindow(fixture.entry, thread, message)).rejects.toThrow();
		for (const transport of [reader, owner]) {
			await expect(transport.history(fixture.entry, thread, message, 0, 50)).rejects.toMatchObject({ status: 404 });
			expect((await transport.message(fixture.entry, thread, message)).message).toMatchObject({ deleted: true, body: null, reactions: [] });
		}
		expect(authorSession.canReviewRemoved(fixture.entry)).toBe(true);
		const catalog = await authorSession.reviewRemovedCatalog(fixture.entry, "Synthetic inventory proof", 0, () => true);
		expect(catalog.items.some(item => item.message_id === message && item.thread_id === thread)).toBe(true);
		const recovered = await authorSession.reviewRemovedHistory(fixture.entry, thread, message, "Synthetic history recovery proof", 1, () => true);
		expect(recovered.audit_id).toMatch(/^[0-9a-f-]{36}$/);
		expect(recovered.revisions).toMatchObject([{ revision: 2, body: rich("After") }, { revision: 3, body: null }]);
		await expect(reader.moderationHistory(fixture.entry, thread, message, "Synthetic denied recovery")).rejects.toMatchObject({ status: 403 });
	} finally { stops.forEach(stop => stop()); await Promise.all([authorSession.close(), readerSession.close()]); }
}, 30_000);

integration("combined permission client grants a read-only reviewer, detects stale saves and reconciles a lost response", async () => {
	const f = JSON.parse(readFileSync(fixturePath!, "utf8")) as { base: string; share: string; entry: string; reviewer: string; owner: string; token: string; ownerToken: string };
	if (new URL(f.base).hostname !== "127.0.0.1") throw new Error("Only a disposable loopback server is allowed");
	const permissions = new PermissionPolicyClient(f.base, { shareId: f.share, actorId: f.owner }, () => f.ownerToken, () => true, fetch);
	const reviewer = new DiscussionTransport({ serverId: f.base, shareId: f.share, accountId: f.reviewer }, async () => ({ accountId: f.reviewer, accessToken: f.token }), fetch);
	const before = await permissions.read();
	const reading = await permissions.save(before, { file_rules: [{ user_id: f.reviewer, path: "", recursive: true, permission: "read" }], comment_rules: [] });
	expect(await reviewer.permissions(f.entry)).toEqual({ read: true, comment: false, edit: false, moderate: false });
	const proposed = applyPermissionOverrides(reading, { user_id: f.reviewer, path: "", recursive: true, file: "read", comment: "allow" });
	expect(permissionChanges(reading, proposed)).toHaveLength(1);
	const unreliable = new PermissionPolicyClient(f.base, { shareId: f.share, actorId: f.owner }, () => f.ownerToken, () => true, async (url, init) => {
		const response = await fetch(url, init); if (init.method === "PUT" && response.ok) { await response.text(); throw new Error("Lost successful response"); } return response;
	});
	await expect(unreliable.save(reading, proposed)).rejects.toMatchObject({ code: "unconfirmed" });
	const confirmed = await permissions.read(); expect(confirmed).toMatchObject(proposed);
	await expect(permissions.save(reading, { file_rules: [], comment_rules: [] })).rejects.toMatchObject({ code: "changed", status: 409 });
	expect(await reviewer.permissions(f.entry)).toEqual({ read: true, comment: true, edit: false, moderate: false });
	expect(await reviewer.send({ operationId: randomUUID(), scopeId: f.entry, type: "thread.create", dependsOn: [], payload: {
		type: "thread.create", thread_id: randomUUID(), message_id: randomUUID(), anchor: { version: 1, type: "note" }, body: { version: 1, blocks: [{ type: "paragraph", children: [{ type: "text", text: "Reviewer preset comment" }] }] } } })).toMatchObject({ changed: true });
	const switched = new PermissionPolicyClient(f.base, { shareId: f.share, actorId: f.owner }, () => f.token, () => true, fetch);
	await expect(switched.read()).rejects.toMatchObject({ code: "account_changed", status: 403 });
	await permissions.save(confirmed, { file_rules: before.file_rules, comment_rules: before.comment_rules });
}, 30_000);

integration("withdrawn comments recover as edited drafts without duplicate sends or detached replies", async () => {
	const fixture = JSON.parse(readFileSync(fixturePath!, "utf8")) as { base: string; share: string; entry: string; owner: string; ownerToken: string };
	if (new URL(fixture.base).hostname !== "127.0.0.1") throw new Error("Only a disposable loopback server is allowed");
	const identity = { serverId: fixture.base, accountId: fixture.owner, shareId: fixture.share, vaultId: "recovery-owner" };
	let loseWithdrawal = true;
	const transport = new DiscussionTransport(identity, async () => ({ accountId: fixture.owner, accessToken: fixture.ownerToken }), async (url, init) => {
		const response = await fetch(url, init);
		if (loseWithdrawal && url.endsWith("/commands/withdraw") && response.ok) { loseWithdrawal = false; await response.text(); throw new Error("Lost withdrawal response"); }
		return response;
	});
	const store = await DiscussionStore.open(identity, new IDBFactory()), session = new DiscussionSession(store, transport);
	let stop: (() => void) | undefined;
	try {
		await session.start(); stop = session.watch(fixture.entry, () => {}); await session.refresh(); session.outbox.stop(); await session.outbox.settled();
		const thread = randomUUID(), message = randomUUID(), childMessage = randomUUID();
		const original = await store.enqueue({ operationId: randomUUID(), scopeId: fixture.entry, type: "thread.create", dependsOn: [], payload: {
			type: "thread.create", thread_id: thread, message_id: message, anchor: { version: 1, type: "note" }, body: protocolJson(bodyFromText("Original saved body")),
		} });
		const child = await store.enqueue({ operationId: randomUUID(), scopeId: fixture.entry, type: "reply.create", dependsOn: [original.operationId], payload: {
			type: "reply.create", thread_id: thread, message_id: childMessage, body: protocolJson(bodyFromText("Waiting reply")),
		} });
		await expect(session.recoverSavedCommand(original)).rejects.toMatchObject({ action: "retry" });
		expect((await store.getOperation(original.operationId))?.state).toBe("queued");
		await expect(transport.send(original)).rejects.toMatchObject({ code: "operation_withdrawn" });
		const recovered = await session.recoverSavedCommand(original);
		if (recovered.status !== "editable") throw new Error("Expected editable recovery");
		const selected = await store.retargetRecoveredDraft(recovered.draft.id, 0, { version: 1, type: "text", document_id: fixture.entry, generation: randomUUID(),
			start: "AA==", end: "AA==", dependency: "AAA=", selected_length: 4, context: { quote: "beta", prefix: "", suffix: "", truncated: false } });
		const whole = await store.retargetRecoveredDraft(selected.id, selected.revision, { version: 1, type: "note" });
		const corrected = bodyFromText("Corrected before sending");
		const draft = { ...whole, revision: whole.revision + 1, body: protocolJson(editableCommentDraft(corrected, () => "Owner")) };
		await store.saveDraft(draft, whole.revision);
		const replacement = { ...original, operationId: randomUUID(), payload: { ...(original.payload as object), body: protocolJson(corrected) } };
		await session.queue(replacement, draft); session.outbox.resume(); await session.outbox.settled();
		expect(await store.getOperation(child.operationId)).toMatchObject({ state: "accepted", dependsOn: [replacement.operationId] });
		const delivered = await transport.thread(fixture.entry, thread);
		expect(delivered.messages).toHaveLength(2);
		expect(delivered.messages.map(item => [item.id, item.body])).toMatchObject([[message, corrected], [childMessage, bodyFromText("Waiting reply")]]);
		expect(await session.recoverSavedCommand(original)).toEqual({ status: "requeued" });
		await expect(transport.send(original)).rejects.toMatchObject({ code: "operation_withdrawn" });
		// An accepted change whose acknowledgement was lost returns its receipt;
		// recovery must not manufacture an editable replacement of that message.
		session.outbox.stop(); await session.outbox.settled();
		const accepted = await store.enqueue({ operationId: randomUUID(), scopeId: fixture.entry, type: "reply.create", dependsOn: [], payload: {
			type: "reply.create", thread_id: thread, message_id: randomUUID(), body: protocolJson(bodyFromText("Accepted before recovery")),
		} });
		await transport.send(accepted);
		expect(await session.recoverSavedCommand(accepted)).toEqual({ status: "accepted" });
		expect(await store.getDraft("recovery:" + accepted.operationId)).toBeUndefined();
		const stale = await store.enqueue({ operationId: randomUUID(), scopeId: fixture.entry, type: "message.edit", dependsOn: [], payload: {
			type: "message.edit", thread_id: thread, message_id: message, expected_revision: 1, body: protocolJson(bodyFromText("My offline edit")),
		} });
		await transport.send({ ...stale, operationId: randomUUID(), payload: { ...(stale.payload as object), body: protocolJson(bodyFromText("Changed on another device")) } });
		await expect(transport.send(stale)).rejects.toMatchObject({ code: "stale_message_revision" });
		const edit = await session.recoverSavedCommand(stale);
		if (edit.status !== "editable") throw new Error("Expected editable stale change");
		expect(edit.draft.body).toMatchObject({ editBaseRevision: 1, text: "My offline edit" });
		const latest = await session.linkedThread(fixture.entry, thread, message);
		expect(latest?.message?.revision).toBe(2);
		await session.queue({ ...stale, operationId: randomUUID(), payload: { ...(stale.payload as object), expected_revision: 2 } }, edit.draft);
		session.outbox.resume(); await session.outbox.settled();
		expect((await transport.message(fixture.entry, thread, message)).message).toMatchObject({ revision: 3, body: bodyFromText("My offline edit") });
		// Explicit local discard follows an actual server fence and includes
		// unsent dependents. A delayed original can never create the thread.
		session.outbox.stop(); await session.outbox.settled();
		const discardedThread = randomUUID();
		const abandoned = await store.enqueue({ operationId: randomUUID(), scopeId: fixture.entry, type: "thread.create", dependsOn: [], payload: {
			type: "thread.create", thread_id: discardedThread, message_id: randomUUID(), anchor: { version: 1, type: "note" }, body: protocolJson(bodyFromText("Discard after review")) } });
		const waiting = await store.enqueue({ operationId: randomUUID(), scopeId: fixture.entry, type: "reply.create", dependsOn: [abandoned.operationId], payload: {
			type: "reply.create", thread_id: discardedThread, message_id: randomUUID(), body: protocolJson(bodyFromText("Dependent local reply")) } });
		expect((await session.recoverSavedCommand(abandoned)).status).toBe("editable");
		const discardReview = await session.reviewAbandonment(abandoned.operationId); expect(discardReview.operations).toHaveLength(2);
		await session.abandonReviewedWork(discardReview, () => true);
		expect(await store.getOperation(waiting.operationId)).toMatchObject({ state: "withdrawn" });
		await expect(transport.send(abandoned)).rejects.toMatchObject({ code: "operation_withdrawn" });
		await expect(transport.thread(fixture.entry, discardedThread)).rejects.toMatchObject({ status: 404 });
	} finally { stop?.(); await session.close(); }
}, 30_000);

integration("reaction cancellation reconciles uncertain delivery without reversing posted reactions", async () => {
	const fixture = JSON.parse(readFileSync(fixturePath!, "utf8")) as { base: string; share: string; entry: string; owner: string; ownerToken: string };
	if (new URL(fixture.base).hostname !== "127.0.0.1") throw new Error("Only a disposable loopback server is allowed");
	const identity = { serverId: fixture.base, accountId: fixture.owner, shareId: fixture.share, vaultId: "reaction-cancel-owner" };
	let loseWithdrawal = true;
	const transport = new DiscussionTransport(identity, async () => ({ accountId: fixture.owner, accessToken: fixture.ownerToken }), async (url, init) => {
		const response = await fetch(url, init);
		if (loseWithdrawal && url.endsWith("/commands/withdraw") && response.ok) { loseWithdrawal = false; await response.text(); throw new Error("Lost cancellation response"); }
		return response;
	});
	const store = await DiscussionStore.open(identity, new IDBFactory()), session = new DiscussionSession(store, transport);
	let stop: (() => void) | undefined;
	try {
		await session.start(); stop = session.watch(fixture.entry, () => {}); await session.refresh(); session.outbox.stop(); await session.outbox.settled();
		const thread = randomUUID(), message = randomUUID();
		await transport.send({ operationId: randomUUID(), scopeId: fixture.entry, type: "thread.create", dependsOn: [], payload: {
			type: "thread.create", thread_id: thread, message_id: message, anchor: { version: 1, type: "note" }, body: protocolJson(bodyFromText("Reaction cancellation fixture")) } });
		const command = (emoji: string, present = true): QueuedCommand => ({ operationId: randomUUID(), scopeId: fixture.entry, type: "reaction.set", dependsOn: [],
			payload: { type: "reaction.set", thread_id: thread, message_id: message, emoji, present } });
		const cancelled = await store.enqueue(command("heart"), 1); await store.claimNext("worker", 2);
		await expect(session.cancelSavedReaction(cancelled, () => true)).rejects.toMatchObject({ action: "retry" });
		expect((await store.getOperation(cancelled.operationId))?.state).toBe("sending");
		await expect(transport.send(cancelled)).rejects.toMatchObject({ code: "operation_withdrawn" });
		expect(await session.cancelSavedReaction(cancelled, () => true)).toBe("withdrawn");
		expect((await transport.thread(fixture.entry, thread)).messages[0].reactions).toEqual([]);
		const delivered = await store.enqueue(command("thumbs_up"), 3); await store.claimNext("worker", 4); await transport.send(delivered);
		expect(await session.cancelSavedReaction(delivered, () => true)).toBe("accepted"); expect((await store.getOperation(delivered.operationId))?.state).toBe("accepted");
		const removal = await store.enqueue(command("thumbs_up", false), 5); session.setForeground(false);
		expect(await session.cancelSavedReaction(removal, () => true)).toBe("withdrawn");
		expect((await transport.thread(fixture.entry, thread)).messages[0].reactions).toEqual([{ emoji: "thumbs_up", count: 1, mine: true }]);
	} finally { stop?.(); await session.close(); }
}, 30_000);
