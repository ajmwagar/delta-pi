import { describe, expect, test } from "bun:test";
import {
	clipForRecord,
	TOOL_BLOCK_LIMIT,
	snapshotUpdates,
	historyNotice,
	SNAPSHOT_TOKEN_BUDGET,
	DeltaSession,
	authorName,
	batches,
	emptyState,
	enqueue,
	itemText,
	messageUpdates,
	parseReceipts,
	parseWatchEvent,
	recordLine,
	remoteText,
	toolInfo,
	type PendingRecord,
} from "./delta";

describe("messageUpdates", () => {
	test("records a user message with its text", () => {
		expect(
			messageUpdates("e1", { role: "user", content: "Please inspect this change." }),
		).toEqual([
			{
				sessionUpdate: "user_message",
				messageId: "e1:message",
				content: [{ type: "text", text: "Please inspect this change." }],
			},
		]);
	});

	test("splits assistant text around thinking and tool calls", () => {
		const updates = messageUpdates("e2", {
			role: "assistant",
			content: [
				{ type: "thinking", thinking: "Check the parser first." },
				{ type: "text", text: "Reading it now." },
				{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "/repo/src/a.ts" } },
			],
			}, "/repo");
		expect(updates).toEqual([
			{
				sessionUpdate: "agent_thought",
				messageId: "e2:thought:0",
				content: [{ type: "text", text: "Check the parser first." }],
			},
			{
				sessionUpdate: "agent_message",
				messageId: "e2:message:1",
				content: [{ type: "text", text: "Reading it now." }],
			},
			{
				sessionUpdate: "tool_call_update",
				toolCallId: "call-1",
				name: "read",
				title: "Read src/a.ts",
				kind: "read",
				status: "in_progress",
				rawInput: { path: "/repo/src/a.ts" },
			},
		]);
	});

	test("closes a tool call with its result", () => {
		expect(
			messageUpdates("e3", {
				role: "toolResult",
				toolCallId: "call-1",
				toolName: "read",
				content: [{ type: "text", text: "file body" }],
				isError: false,
			}),
		).toEqual([
			{
				sessionUpdate: "tool_call_update",
				toolCallId: "call-1",
				status: "completed",
				rawOutput: null,
				content: [{ type: "content", content: { type: "text", text: "file body" } }],
			},
		]);
	});

	test("marks a failed tool call failed", () => {
		const [update] = messageUpdates("e4", {
			role: "toolResult",
			toolCallId: "call-2",
			content: [{ type: "text", text: "exit 1" }],
			isError: true,
		});
		expect(update).toMatchObject({ toolCallId: "call-2", status: "failed" });
	});

	test("ignores messages it cannot record", () => {
		expect(messageUpdates("e5", { role: "system", content: "prompt" })).toEqual([]);
	});
});

describe("toolInfo", () => {
	test("shows paths relative to the checkout", () => {
		expect(toolInfo("edit", { path: "/repo/src/a.ts" }, "/repo")).toEqual({
			title: "Edit src/a.ts",
			kind: "edit",
		});
	});

	test("keeps a path outside the checkout absolute", () => {
		expect(toolInfo("read", { path: "/elsewhere/b.ts" }, "/repo").title).toBe("Read /elsewhere/b.ts");
	});
});

describe("outbox", () => {
	const save = () => {};

	test("a turn's running state names its own sequence", () => {
		const state = emptyState("s1");
		const sequence = enqueue(state, { sessionUpdate: "state_update", state: "running" }, { save });
		expect(sequence).toBe(1);
		expect(JSON.parse(state.pending[0].line)).toEqual({
			schemaVersion: 1,
			sequence: 1,
			turnSequence: 1,
			update: { sessionUpdate: "state_update", state: "running" },
		});
	});

	test("turn content carries the turn's sequence, not its own", () => {
		const state = emptyState("s1");
		enqueue(state, { sessionUpdate: "state_update", state: "running" }, { save });
		enqueue(state, { sessionUpdate: "agent_message", messageId: "m", content: [] }, { save, turnSequence: 1 });
		expect(state.next).toBe(3);
		expect(JSON.parse(state.pending[1].line)).toMatchObject({ sequence: 2, turnSequence: 1 });
	});

	test("history records carry no turn", () => {
		const line = recordLine(7, { sessionUpdate: "user_message", messageId: "m", content: [] });
		expect(JSON.parse(line)).toEqual({
			schemaVersion: 1,
			sequence: 7,
			update: { sessionUpdate: "user_message", messageId: "m", content: [] },
		});
	});

	test("batches stay under the input limit and keep order", () => {
		const pending: PendingRecord[] = [
			{ sequence: 1, line: `${"a".repeat(600)}\n` },
			{ sequence: 2, line: `${"b".repeat(600)}\n` },
			{ sequence: 3, line: `${"c".repeat(600)}\n` },
		];
		expect(batches(pending, 1_000).map((batch) => batch.map((record) => record.sequence))).toEqual([
			[1],
			[2],
			[3],
		]);
	});
});

describe("parseReceipts", () => {
	test("reads recorded, duplicate, and fenced receipts", () => {
		const stdout = [
			'{"operation":"appended","thread_id":"t","sequence":1,"next_sequence":2,"duplicate":false,"disposition":"recorded","turn_sequence":1}',
			'{"operation":"appended","thread_id":"t","sequence":2,"next_sequence":3,"duplicate":true,"disposition":"duplicate","turn_sequence":null}',
			'{"operation":"appended","thread_id":"t","sequence":3,"next_sequence":4,"duplicate":false,"disposition":"fenced","turn_sequence":2}',
		].join("\n");
		expect(parseReceipts(stdout)).toEqual([
			{ sequence: 1, next_sequence: 2, disposition: "recorded", turn_sequence: 1 },
			{ sequence: 2, next_sequence: 3, disposition: "duplicate", turn_sequence: null },
			{ sequence: 3, next_sequence: 4, disposition: "fenced", turn_sequence: 2 },
		]);
	});

	test("an error line is not a receipt", () => {
		expect(parseReceipts('{"error":{"code":"sequence_gap","message":"gap"}}')).toEqual([]);
	});
});

describe("watch events", () => {
	test("keeps unknown event types instead of failing", () => {
		expect(parseWatchEvent('{"type":"future_event","x":1}')).toEqual({ type: "unknown", name: "future_event" });
	});

	test("decodes a remote message", () => {
		const event = parseWatchEvent(
			JSON.stringify({
				type: "item",
				item: {
					id: "i1",
					kind: "user_message",
					content: { text: "Can you also update the docs?" },
					author: { user_id: "u1", name: "Ada" },
				},
			}),
		);
		expect(event).toEqual({
			type: "item",
			item: {
				id: "i1",
				kind: "user_message",
				content: { text: "Can you also update the docs?" },
				author: { user_id: "u1", name: "Ada" },
			},
		});
	});

	test("decodes supersession", () => {
		expect(parseWatchEvent('{"type":"producer.turn","sequence":4,"status":"superseded"}')).toEqual({
			type: "producer.turn",
			sequence: 4,
			status: "superseded",
		});
	});

	test("an error envelope becomes a typed failure", () => {
		const event = parseWatchEvent('{"error":{"code":"not_visible","message":"no access"}}');
		expect(event).toMatchObject({ type: "error", error: { code: "not_visible" } });
	});
});

describe("remote text", () => {
	test("names the person who wrote it", () => {
		expect(remoteText("user_message", { user_id: "u1", name: "Ada" }, "hi")).toBe("**Ada** (Delta): hi");
	});

	test("falls back when Delta has no name yet", () => {
		expect(authorName(null)).toBe("Someone in Delta");
		expect(itemText({ text: "x" })).toBe("x");
	});
});

describe("snapshot", () => {
	const entries = (texts: string[]) =>
		texts.map((text, index) => ({
			type: "message",
			id: `e${index}`,
			message: { role: "assistant", content: [{ type: "text", text }] },
		}));

	test("keeps the whole session when it fits the budget", () => {
		const plan = snapshotUpdates(entries(["one", "two"]));
		expect(plan.omitted).toBe(0);
		expect(plan.total).toBe(2);
		expect(plan.updates).toHaveLength(2);
	});

	test("keeps the newest messages and counts the rest as omitted", () => {
		const plan = snapshotUpdates(entries(["old".repeat(200), "middle".repeat(200), "newest"]), {
			budget: 400,
		});
		expect(plan.total).toBe(3);
		expect(plan.omitted).toBe(2);
		expect(JSON.stringify(plan.updates)).toContain("newest");
		expect(JSON.stringify(plan.updates)).not.toContain("middle");
	});

	test("always keeps the newest message, even past the budget", () => {
		const plan = snapshotUpdates(entries(["a".repeat(5_000)]), { budget: 10 });
		expect(plan.updates).toHaveLength(1);
	});

	test("clips one oversized block and says how much it left out", () => {
		const [update] = snapshotUpdates(entries(["x".repeat(20_000)]), { budget: 10 }).updates;
		const text = (update.content as { text: string }[])[0].text;
		expect(text.length).toBeLessThan(20_000);
		expect(text).toContain("more characters]");
	});

	test("the default budget is 100k tokens", () => {
		expect(SNAPSHOT_TOKEN_BUDGET).toBe(100_000);
	});

	test("the notice names the thread and how to read the rest", () => {
		const notice = historyNotice(12, 40, "ksQQthread");
		expect(notice).toContain("40 messages");
		expect(notice).toContain("12 oldest");
		expect(notice).toContain("delta thread show ksQQthread --format messages --messages 1-20");
	});
});

describe("tool records", () => {
	const patch = [
		"diff --git a/src/a.ts b/src/a.ts",
		"--- a/src/a.ts",
		"+++ b/src/a.ts",
		"@@ -1,1 +1,1 @@",
		"-old",
		"+new",
		"",
	].join("\n");

	test("an edit's patch becomes a diff block naming the file", () => {
		const [update] = messageUpdates("e9", {
			role: "toolResult",
			toolCallId: "call-9",
			toolName: "edit",
			content: [{ type: "text", text: "edited" }],
			details: { patch, diff: "-old\n+new" },
			isError: false,
		}, "/repo");
		expect(update).toMatchObject({
			sessionUpdate: "tool_call_update",
			toolCallId: "call-9",
			status: "completed",
			rawOutput: null,
			content: [
				{
					type: "diff",
					changes: [{ operation: "modify", path: "/repo/src/a.ts" }],
					patch: { format: "git_patch", text: patch },
				},
			],
		});
	});

	test("a new file's patch is recorded as an add", () => {
		const added = ["diff --git a/n.ts b/n.ts", "new file mode 100644", "--- /dev/null", "+++ b/n.ts", "@@ -0,0 +1 @@", "+x", ""].join(
			"\n",
		);
		const [update] = messageUpdates("e10", {
			role: "toolResult",
			toolCallId: "call-10",
			toolName: "write",
			content: [],
			details: { patch: added },
			isError: false,
		});
		const diff = (update.content as { changes: { operation: string }[] }[])[0];
		expect(diff.changes[0].operation).toBe("add");
	});

	test("a live tool result is clipped so Delta will accept it", () => {
		const huge = "x".repeat(1_000_000);
		const [update] = messageUpdates("e11", {
			role: "toolResult",
			toolCallId: "call-11",
			toolName: "bash",
			content: [{ type: "text", text: huge }],
			isError: false,
		});
		const clipped = clipForRecord(update);
		const text = JSON.stringify(clipped);
		expect(text.length).toBeLessThan(TOOL_BLOCK_LIMIT + 2_000);
		expect(text).toContain("more characters]");
	});

	test("a tool's huge details are not duplicated beside its output", () => {
		const [update] = messageUpdates("e12", {
			role: "toolResult",
			toolCallId: "call-12",
			toolName: "bash",
			content: [{ type: "text", text: "ok" }],
			details: { stdout: "x".repeat(5_000) },
			isError: false,
		});
		expect(update.rawOutput).toBeNull();
	});
});

describe("audience", () => {
	test("unshare before sharing says what to do", async () => {
		const session = new DeltaSession(
			{} as never,
			{
				cwd: "/tmp",
				hasUI: false,
				abort: () => {},
				sessionManager: { getSessionId: () => `audience-${Date.now()}`, getEntries: () => [] },
			} as never,
		);
		await expect(session.unshare()).rejects.toThrow(/no Delta thread yet/);
	});
});
