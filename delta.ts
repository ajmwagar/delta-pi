/**
 * delta — record a Pi session into a Delta thread, and bring Delta's shared
 * activity back into Pi.
 *
 * A Pi session records itself as a Delta "producer": `--source pi` plus Pi's own
 * session id as `--external-id`. Delta stores the pair, so reconnecting with the
 * same ids finds (or creates) the same thread and its sequence numbers continue.
 *
 * Contract: https://delta.dev/docs/cli/build-a-plugin (recording contract 8-9),
 * with zed-industries/delta-claude as the reference implementation.
 *
 * Sections: Delta CLI, Session state, Recording, Watch, Sharing, Extension entry.
 */
import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

// ============================================================================
// Delta CLI
// ============================================================================

/** The fixed producer name Delta stores for every Pi session. */
export const SOURCE = "pi";
/** How this producer's output is attributed in Delta's transcript. */
export const PRODUCER_NAME = "Pi";
/** The recording contract versions this plugin speaks. */
export const CONTRACT = { min: 8, max: 9 } as const;

const DELTA_BIN = process.env.DELTA_BIN || "delta";
const AGENT_ROOT = process.env.PI_AGENT_HOME || path.join(os.homedir(), ".pi", "agent");
const STATE_DIR = path.join(AGENT_ROOT, "state", "delta");

/** A typed failure from a `delta` command, keeping the envelope's stable code. */
export class DeltaError extends Error {
	constructor(
		readonly code: string,
		message: string,
		readonly retryable?: boolean,
		readonly retryAfterMs?: number,
		readonly reason?: string,
	) {
		super(message);
		this.name = "DeltaError";
	}
}

type RunResult = { code: number | null; stdout: string; stderr: string };

/** Run one `delta` command, optionally feeding stdin, and collect its output. */
export function runDelta(
	args: string[],
	options: { cwd?: string; stdin?: string; signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<RunResult> {
	return new Promise((resolve, reject) => {
		const child = spawn(DELTA_BIN, args, { cwd: options.cwd, stdio: ["pipe", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		let settled = false;
		const timer = options.timeoutMs
			? setTimeout(() => child.kill("SIGTERM"), options.timeoutMs)
			: undefined;
		const abort = () => child.kill("SIGTERM");
		options.signal?.addEventListener("abort", abort, { once: true });
		const finish = (result: RunResult) => {
			if (settled) return;
			settled = true;
			if (timer) clearTimeout(timer);
			options.signal?.removeEventListener("abort", abort);
			resolve(result);
		};
		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		child.stdout.on("data", (chunk: string) => (stdout += chunk));
		child.stderr.on("data", (chunk: string) => (stderr += chunk));
		child.on("error", (error) => {
			if (settled) return;
			settled = true;
			if (timer) clearTimeout(timer);
			reject(new DeltaError("process_failed", `could not run \`${DELTA_BIN}\`: ${error.message}`));
		});
		child.on("close", (code) => finish({ code, stdout, stderr }));
		// A command that never reads stdin closes it early; the exit code reports why.
		child.stdin.on("error", () => {});
		child.stdin.end(options.stdin ?? "");
	});
}

/** The error envelope a `delta --json` answer carries, if any. */
export function envelopeError(value: unknown): DeltaError | undefined {
	if (!value || typeof value !== "object") return undefined;
	const error = (value as { error?: unknown }).error;
	if (!error || typeof error !== "object") return undefined;
	const envelope = error as Record<string, unknown>;
	if (typeof envelope.code !== "string" || typeof envelope.message !== "string") return undefined;
	const reason = typeof envelope.reason === "string" && envelope.reason ? envelope.reason : undefined;
	const label = reason && reason !== envelope.code ? `${envelope.code} (${reason})` : envelope.code;
	return new DeltaError(
		envelope.code,
		`${label}: ${envelope.message}`,
		typeof envelope.retryable === "boolean" ? envelope.retryable : undefined,
		typeof envelope.retry_after_ms === "number" ? envelope.retry_after_ms : undefined,
		reason,
	);
}

/**
 * Parse a `delta --json` answer, raising the CLI's failure envelope as a throw.
 *
 * Some commands print one compact object; others pretty-print an array. Both are
 * accepted, and the failure envelope is checked wherever it appears.
 */
export function parseAnswer<T = unknown>(stdout: string, command: string): T {
	const text = stdout.trim();
	if (!text) throw new DeltaError("command_failed", `${command} printed no output`);
	for (const candidate of [text, ...text.split("\n").reverse()]) {
		let value: unknown;
		try {
			value = JSON.parse(candidate);
		} catch {
			continue;
		}
		const failure = envelopeError(value);
		if (failure) throw failure;
		return value as T;
	}
	throw new DeltaError("command_failed", `${command} printed something other than JSON`);
}

/** Run a `delta --json` command whose answer is one JSON object. */
export async function deltaJson<T = Record<string, unknown>>(
	args: string[],
	options: { cwd?: string; stdin?: string; signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<T> {
	const result = await runDelta(["--json", ...args], options);
	return parseAnswer<T>(result.stdout, args.join(" "));
}

/** Check that this plugin and the installed CLI speak a common recording contract. */
export async function verifyContract(signal?: AbortSignal): Promise<void> {
	const answer = await deltaJson<{ min?: number; max?: number }>(["thread", "contract"], { signal });
	if (typeof answer.min !== "number" || typeof answer.max !== "number") {
		throw new DeltaError("command_failed", "Delta CLI did not report a recording contract");
	}
	if (answer.max < CONTRACT.min) {
		throw new DeltaError("incompatible_app", "Update Delta: this plugin needs recording contract 8");
	}
	if (answer.min > CONTRACT.max) {
		throw new DeltaError("incompatible_app", "Update the delta plugin for Pi: Delta speaks a newer contract");
	}
}

/** The organization Delta creates new threads under. */
async function currentOrganization(): Promise<string | undefined> {
	const answer = await deltaJson<{ organizations?: { id: string; current: boolean }[] }>(["org", "list"]);
	return answer.organizations?.find((organization) => organization.current)?.id;
}

// ============================================================================
// Session state
// ============================================================================

/** One saved record, on disk until Delta confirms it. */
export type PendingRecord = {
	sequence: number;
	turnSequence?: number;
	/** The exact JSONL line sent to `thread append`. */
	line: string;
};

/** What this computer knows about one Pi session's Delta thread. */
export type SessionState = {
	source: string;
	externalId: string;
	threadId?: string;
	url?: string;
	/** The audience the thread was created with. */
	visibility?: "private" | "organization";
	/** The worktree Delta attached for this checkout, and where it is mounted. */
	worktreeReference?: string;
	checkout?: string;
	/** A joined thread's mount directory, where Delta placed every worktree. */
	directory?: string;
	/** The next sequence number to assign; saved with the pending records. */
	next: number;
	pending: PendingRecord[];
	/** The last turn this producer recorded, so a resumed session keeps its turn id. */
	lastTurnSequence?: number;
	/** The thread title last recorded, so each rename is recorded once. */
	title?: string;
};

function stateFile(sessionId: string): string {
	return path.join(STATE_DIR, "sessions", `${sessionId.replace(/[^A-Za-z0-9._-]/g, "_")}.json`);
}

export function emptyState(sessionId: string): SessionState {
	return { source: SOURCE, externalId: sessionId, next: 1, pending: [] };
}

export function loadState(sessionId: string): SessionState {
	try {
		const parsed: unknown = JSON.parse(fs.readFileSync(stateFile(sessionId), "utf8"));
		if (!parsed || typeof parsed !== "object") return emptyState(sessionId);
		const state = parsed as SessionState;
		return {
			...emptyState(sessionId),
			...state,
			source: SOURCE,
			externalId: sessionId,
			next: Number.isSafeInteger(state.next) && state.next > 0 ? state.next : 1,
			pending: Array.isArray(state.pending) ? state.pending : [],
		};
	} catch {
		return emptyState(sessionId);
	}
}

/** Write atomically: a half-written outbox would lose records. */
export function saveState(state: SessionState): void {
	const file = stateFile(state.externalId);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	const temporary = `${file}.tmp`;
	fs.writeFileSync(temporary, `${JSON.stringify(state, null, "\t")}\n`);
	fs.renameSync(temporary, file);
}

// ============================================================================
// Recording
// ============================================================================

type Update = Record<string, unknown> & { sessionUpdate: string };

/** The ACP content block for one Pi content block, or undefined when it is not recordable. */
export function contentBlock(block: unknown): Record<string, unknown> | undefined {
	if (!block || typeof block !== "object") return undefined;
	const value = block as Record<string, unknown>;
	if (value.type === "text" && typeof value.text === "string") return { type: "text", text: value.text };
	if (value.type === "image" && typeof value.data === "string" && typeof value.mimeType === "string") {
		return { type: "image", data: value.data, mimeType: value.mimeType };
	}
	return undefined;
}

/** A tool call's title and ACP kind, as Delta's own agents report them. */
export function toolInfo(name: string, input: unknown, root?: string): { title: string; kind: string } {
	const value = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
	const field = (key: string) =>
		typeof value[key] === "string" && value[key] ? (value[key] as string) : undefined;
	const shown = (full: string | undefined) => {
		if (!full || !root) return full;
		const base = root.replace(/\/+$/, "");
		return full.startsWith(`${base}/`) ? full.slice(base.length + 1) : full;
	};
	const info = (title: string, kind: string) => ({ title: title.replace(/\s+/g, " ").trim(), kind });
	switch (name) {
		case "bash":
			return info(field("command") ?? "Terminal", "execute");
		case "read": {
			const offset = typeof value.offset === "number" && value.offset ? value.offset : undefined;
			const limit = typeof value.limit === "number" && value.limit > 0 ? value.limit : undefined;
			const lines = limit
				? ` (${offset ?? 1} - ${(offset ?? 1) + limit - 1})`
				: offset
					? ` (from line ${offset})`
					: "";
			return info(`Read ${shown(field("path")) ?? "File"}${lines}`, "read");
		}
		case "edit":
		case "write": {
			const file = shown(field("path"));
			return info(file ? `${name === "edit" ? "Edit" : "Write"} ${file}` : name, "edit");
		}
		case "grep": {
			const parts = ["grep"];
			if (field("pattern")) parts.push(`"${field("pattern")}"`);
			if (shown(field("path"))) parts.push(shown(field("path"))!);
			return info(parts.join(" "), "search");
		}
		case "find":
		case "ls":
			return info([name, shown(field("path"))].filter(Boolean).join(" "), "search");
		default:
			return info(name || "Unknown Tool", "other");
	}
}

/**
 * Translate one Pi message into the ACP updates Delta records.
 *
 * `entryId` names the update's message id, so retrying an interrupted turn
 * re-sends the same ids instead of duplicating rows.
 */
export function messageUpdates(entryId: string, message: unknown, root?: string): Update[] {
	if (!message || typeof message !== "object") return [];
	const value = message as Record<string, unknown>;
	const role = value.role;
	const rawContent = value.content;
	const parts: unknown[] = Array.isArray(rawContent)
		? rawContent
		: typeof rawContent === "string"
			? [{ type: "text", text: rawContent }]
			: [];

	if (role === "user") {
		const content = parts.map(contentBlock).filter((block): block is Record<string, unknown> => !!block);
		if (!content.length) return [];
		return [{ sessionUpdate: "user_message", messageId: `${entryId}:message`, content }];
	}

	if (role === "assistant") {
		const updates: Update[] = [];
		let content: Record<string, unknown>[] = [];
		const flush = () => {
			if (!content.length) return;
			updates.push({
				sessionUpdate: "agent_message",
				messageId: `${entryId}:message:${updates.length}`,
				content,
			});
			content = [];
		};
		for (const part of parts) {
			const block = part as Record<string, unknown>;
			if (block?.type === "thinking" && typeof block.thinking === "string") {
				flush();
				const text = block.redacted ? "[redacted thinking]" : block.thinking;
				if (!text.trim()) continue;
				updates.push({
					sessionUpdate: "agent_thought",
					messageId: `${entryId}:thought:${updates.length}`,
					content: [{ type: "text", text }],
				});
				continue;
			}
			if (block?.type === "toolCall" && typeof block.id === "string") {
				flush();
				const name = typeof block.name === "string" ? block.name : "Tool";
				const { title, kind } = toolInfo(name, block.arguments, root);
				updates.push({
					sessionUpdate: "tool_call_update",
					toolCallId: block.id,
					name,
					title,
					kind,
					status: "in_progress",
					rawInput: block.arguments ?? {},
				});
				continue;
			}
			const converted = contentBlock(block);
			if (converted) content.push(converted);
		}
		flush();
		return updates;
	}

	if (role === "toolResult" && typeof value.toolCallId === "string") {
		// An edit's unified patch reads as a diff in Delta, the way the reference
		// plugin records Claude's Edit and Write calls, instead of as a wall of text.
		const diff = patchDiff(value.details, root);
		const blocks = diff
			? []
			: parts.map(contentBlock).filter((block): block is Record<string, unknown> => !!block);
		return [
			{
				sessionUpdate: "tool_call_update",
				toolCallId: value.toolCallId,
				status: value.isError === true ? "failed" : "completed",
				rawOutput: diff ? null : smallDetails(value.details),
				...(diff
					? { content: [diff] }
					: blocks.length
						? { content: blocks.map((block) => ({ type: "content", content: block })) }
						: {}),
			},
		];
	}

	return [];
}


/** A tool's structured details, kept only when small enough to sit beside its output. */
function smallDetails(details: unknown): unknown {
	if (details == null) return null;
	try {
		const text = JSON.stringify(details);
		return text && text.length <= 2_000 ? details : null;
	} catch {
		return null;
	}
}
/**
 * An edit's unified patch as an ACP diff block, naming the file it changes.
 *
 * ACP names changed files by absolute path, so the patch's own headers are
 * resolved against the checkout when it is known.
 */
export function patchDiff(details: unknown, root?: string): Record<string, unknown> | undefined {
	if (!details || typeof details !== "object") return undefined;
	const patch = (details as { patch?: unknown }).patch;
	if (typeof patch !== "string" || !patch.trim()) return undefined;
	const file = /^\+\+\+ b\/(.+)$/m.exec(patch)?.[1] ?? /^--- a\/(.+)$/m.exec(patch)?.[1];
	if (!file) return undefined;
	const operation = /^new file mode/m.test(patch)
		? "add"
		: /^deleted file mode/m.test(patch)
			? "delete"
			: "modify";
	return {
		type: "diff",
		changes: [{ operation, path: root ? path.join(root, file) : file }],
		patch: { format: "git_patch", text: patch },
	};
}

/** One saved outbox line, keeping each record's own turn association. */
export function recordLine(sequence: number, update: Update, turnSequence?: number): string {
	const record: Record<string, unknown> = { schemaVersion: 1, sequence };
	if (turnSequence !== undefined) record.turnSequence = turnSequence;
	record.update = update;
	return `${JSON.stringify(record)}\n`;
}

/**
 * Add a record to the durable outbox before it is sent.
 *
 * A turn's own start is the only update that may name its own sequence: the
 * `running` state update recorded as sequence N carries `turnSequence` N. The
 * record is clipped first, so one enormous tool result cannot make a record
 * Delta will refuse.
 */
export function enqueue(
	state: SessionState,
	update: Update,
	options: { turnSequence?: number; save: (state: SessionState) => void },
): number {
	const sequence = state.next;
	const turnSequence =
		update.sessionUpdate === "state_update" && update.state === "running" ? sequence : options.turnSequence;
	const record = clipForRecord(update);
	state.pending.push({ sequence, turnSequence, line: recordLine(sequence, record, turnSequence) });
	state.next = sequence + 1;
	options.save(state);
	return sequence;
}

/** One line of `thread append` output. */
export type AppendReceipt = {
	sequence: number;
	next_sequence: number;
	disposition: "recorded" | "fenced" | "duplicate";
	turn_sequence: number | null;
};

/** Read the receipts a batch of appends produced, in order. */
export function parseReceipts(stdout: string): AppendReceipt[] {
	const receipts: AppendReceipt[] = [];
	for (const line of stdout.trim().split("\n")) {
		if (!line.trim()) continue;
		let value: unknown;
		try {
			value = JSON.parse(line);
		} catch {
			continue;
		}
		if (envelopeError(value)) continue;
		const receipt = value as Record<string, unknown>;
		if (typeof receipt.sequence !== "number" || typeof receipt.disposition !== "string") continue;
		receipts.push({
			sequence: receipt.sequence,
			next_sequence: typeof receipt.next_sequence === "number" ? receipt.next_sequence : receipt.sequence + 1,
			disposition: receipt.disposition as AppendReceipt["disposition"],
			turn_sequence: typeof receipt.turn_sequence === "number" ? receipt.turn_sequence : null,
		});
	}
	return receipts;
}

/** Split pending records into append batches that stay under the CLI's input limits. */
export function batches(pending: readonly PendingRecord[], limit = 2_000_000): PendingRecord[][] {
	const result: PendingRecord[][] = [];
	let batch: PendingRecord[] = [];
	let bytes = 0;
	for (const record of pending) {
		const size = Buffer.byteLength(record.line, "utf8");
		if (batch.length && bytes + size > limit) {
			result.push(batch);
			batch = [];
			bytes = 0;
		}
		batch.push(record);
		bytes += size;
	}
	if (batch.length) result.push(batch);
	return result;
}

// ---------------------------------------------------------------------------
// Snapshot: the session a thread starts with
// ---------------------------------------------------------------------------

/** Roughly four bytes per token, the estimate Delta's reference plugin uses. */
export const SNAPSHOT_TOKEN_BUDGET = 100_000;
const SNAPSHOT_CHAR_BUDGET = SNAPSHOT_TOKEN_BUDGET * 4;
/** How much of one content block a snapshot keeps, so one tool dump cannot fill it. */
const SNAPSHOT_BLOCK_LIMIT = 16_000;
/** How much of a tool's output a live record keeps; the rest is named, not sent. */
export const TOOL_BLOCK_LIMIT = 8_000;
/** How much of one message a live record keeps. Messages are rarely near this. */
export const MESSAGE_BLOCK_LIMIT = 200_000;

/** Shrink one update's text, naming what it left out. */
export function clipUpdate(update: Update, limit = SNAPSHOT_BLOCK_LIMIT): Update {
	const clip = (text: string): string =>
		text.length <= limit ? text : `${text.slice(0, limit)}\n[… ${text.length - limit} more characters]`;
	const content = Array.isArray(update.content)
		? update.content.map((block) => {
				const value = block as Record<string, unknown>;
				if (value.type === "text" && typeof value.text === "string") {
					return { ...value, text: clip(value.text) };
				}
				if (value.type === "content" && value.content && typeof value.content === "object") {
					const inner = value.content as Record<string, unknown>;
					if (inner.type === "text" && typeof inner.text === "string") {
						return { ...value, content: { ...inner, text: clip(inner.text) } };
					}
				}
				return value;
			})
		: update.content;
	const rawOutput = typeof update.rawOutput === "string" ? clip(update.rawOutput) : update.rawOutput;
	return { ...update, ...(content === undefined ? {} : { content }), ...(rawOutput === undefined ? {} : { rawOutput }) };
}

/**
 * Keep one record small.
 *
 * Delta rejects a record over 16 MiB, and a single command can print more than
 * that; tool output is the only part of a session that routinely does. Anything
 * cut is named in the record, so the transcript never silently loses text.
 */
export function clipForRecord(update: Update): Update {
	const limit = update.sessionUpdate === "tool_call_update" ? TOOL_BLOCK_LIMIT : MESSAGE_BLOCK_LIMIT;
	return clipUpdate(update, limit);
}
/** What a thread's transcript says about the part of the session it leaves out. */
export function historyNotice(omitted: number, total: number, thread: string): string {
	return (
		`[Delta] This Pi session already had ${total} messages when recording started; ` +
		`the ${omitted} oldest were left out of the transcript. Read them with ` +
		`\`delta thread show ${thread} --format messages --messages 1-20\` (20 messages per call).`
	);
}

export type SnapshotPlan = { updates: Update[]; omitted: number; total: number };

/**
 * The newest part of a session that fits the snapshot budget.
 *
 * A long session would otherwise take minutes to stream and fill the thread with
 * history nobody rereads. Messages are taken from the newest backwards until the
 * budget is spent, and `omitted` says how many older ones the thread leaves out;
 * the CLI can read them back. The newest message is always included.
 */
export function snapshotUpdates(
	entries: readonly unknown[],
	options: { root?: string; budget?: number } = {},
): SnapshotPlan {
	const budget = options.budget ?? SNAPSHOT_CHAR_BUDGET;
	const messages = entries.flatMap((entry) => {
		const value = entry as { id?: unknown; type?: unknown; message?: unknown };
		return value.type === "message" && typeof value.id === "string" && value.message
			? [{ id: value.id, message: value.message }]
			: [];
	});
	const groups = messages.map((message) => {
		const updates = messageUpdates(message.id, message.message, options.root).map((update) => clipUpdate(update));
		const size = updates.reduce((total, update) => total + Buffer.byteLength(JSON.stringify(update)), 0);
		return { updates, size };
	});
	let first = groups.length;
	let used = 0;
	for (let index = groups.length - 1; index >= 0; index -= 1) {
		const group = groups[index];
		if (!group) continue;
		if (first < groups.length && used + group.size > budget) break;
		used += group.size;
		first = index;
	}
	return {
		updates: groups.slice(first).flatMap((group) => group.updates),
		omitted: first,
		total: messages.length,
	};
}

// ============================================================================
// Watch
// ============================================================================

type ThreadUser = { user_id: string | null; name: string | null; actor_id?: string };

export type WatchEvent =
	| { type: "ready" }
	| { type: "live" }
	| {
			type: "item";
			item: { id: string; kind: string; content: Record<string, unknown>; author: ThreadUser | null };
	  }
	| { type: "producer.turn"; sequence: number; status: string }
	| {
			type: "comment";
			comment: { id: string; text: string; author: ThreadUser; target: unknown };
	  }
	| { type: "error"; error: DeltaError }
	| { type: "unknown"; name: string };

/** Decode one watch line; unknown event types are kept so a newer CLI still works. */
export function parseWatchEvent(line: string): WatchEvent | undefined {
	if (!line.trim()) return undefined;
	let value: unknown;
	try {
		value = JSON.parse(line);
	} catch {
		return undefined;
	}
	if (!value || typeof value !== "object") return undefined;
	const event = value as Record<string, unknown>;
	const failure = envelopeError(event);
	if (failure) return { type: "error", error: failure };
	switch (event.type) {
		case "ready":
			return { type: "ready" };
		case "live":
			return { type: "live" };
		case "item": {
			const item = event.item as Record<string, unknown> | undefined;
			if (!item || typeof item.id !== "string" || typeof item.kind !== "string") return undefined;
			return {
				type: "item",
				item: {
					id: item.id,
					kind: item.kind,
					content: (item.content ?? {}) as Record<string, unknown>,
					author: (item.author ?? null) as ThreadUser | null,
				},
			};
		}
		case "producer.turn":
			return typeof event.sequence === "number" && typeof event.status === "string"
				? { type: "producer.turn", sequence: event.sequence, status: event.status }
				: undefined;
		case "comment": {
			const comment = event.comment as Record<string, unknown> | undefined;
			if (!comment || typeof comment.id !== "string" || typeof comment.text !== "string") return undefined;
			return {
				type: "comment",
				comment: {
					id: comment.id,
					text: comment.text,
					author: (comment.author ?? { user_id: null, name: null }) as ThreadUser,
					target: comment.target,
				},
			};
		}
		default:
			return typeof event.type === "string" ? { type: "unknown", name: event.type } : undefined;
	}
}

/** The text a person wrote, for the item kinds that carry one. */
export function itemText(content: Record<string, unknown>): string | undefined {
	return typeof content.text === "string" ? content.text : undefined;
}

/** Item kinds whose text belongs in Pi's context. */
export const MESSAGE_KINDS = new Set(["user_message", "agent_message", "cross_agent_message"]);

/** A short name for who wrote an item. */
export function authorName(author: ThreadUser | null): string {
	return author?.name?.trim() || "Someone in Delta";
}

/** Fold an item's text into one message Pi can read. */
export function remoteText(kind: string, author: ThreadUser | null, text: string): string {
	if (kind === "cross_agent_message") return `**Delta agent:** ${text}`;
	return `**${authorName(author)}** (Delta): ${text}`;
}

// ============================================================================
// Session runtime
// ============================================================================

/** How long to wait before asking again after a delivery failure. */
const RETRY_MIN_MS = 5_000;
const RETRY_MAX_MS = 60_000;

/** Every line a child process writes, in order, without holding partial lines. */
function readLines(child: ChildProcess, onLine: (line: string) => void): void {
	let buffer = "";
	child.stdout?.setEncoding("utf8");
	child.stdout?.on("data", (chunk: string) => {
		buffer += chunk;
		let index = buffer.indexOf("\n");
		while (index >= 0) {
			const line = buffer.slice(0, index).trim();
			buffer = buffer.slice(index + 1);
			if (line) onLine(line);
			index = buffer.indexOf("\n");
		}
	});
}

/** One Pi session's binding to a Delta thread, its outbox, its child processes. */
export class DeltaSession {
	private state: SessionState;
	private turnSequence: number | undefined;
	private queue: Promise<void> = Promise.resolve();
	private watch?: ChildProcess;
	private mounts: ChildProcess[] = [];
	private retryDelay = RETRY_MIN_MS;
	private retryTimer?: ReturnType<typeof setTimeout>;
	private live = false;
	private stopping = false;
	private lastReported?: string;

	constructor(
		private readonly pi: ExtensionAPI,
		private readonly ctx: ExtensionContext,
	) {
		this.state = loadState(ctx.sessionManager.getSessionId());
	}

	get sharing(): boolean {
		return !!this.state.threadId;
	}

	/** Resume recording for a session that was shared before Pi restarted. */
	async resume(reason: string): Promise<void> {
		if (!this.sharing || !this.state.threadId) return;
		try {
			await verifyContract();
			const status = await deltaJson<{
				thread_id: string;
				url: string | null;
				producer: { next_sequence: number } | null;
			}>([
				"thread",
				"status",
				this.state.threadId,
				"--source",
				SOURCE,
				"--external-id",
				this.state.externalId,
			]);
			if (status.url) this.state.url = status.url;
			saveState(this.state);
			this.startWatch();
			if (this.state.worktreeReference && this.state.checkout) {
				this.startMount(this.state.worktreeReference, this.state.checkout, true);
			}
			this.report(`Resumed recording into Delta (${reason}).`, "info");
			if (this.state.pending.length) void this.flush();
		} catch (error) {
			this.report(`Delta recording is paused: ${describe(error)}`, "warning");
		}
	}

	/** Record one Pi message, if this session is shared. */
	recordMessage(entryId: string, message: unknown): void {
		if (!this.sharing) return;
		for (const update of messageUpdates(entryId, message, this.state.checkout)) {
			this.record(update);
		}
	}

	/** A turn began: start it in Delta so its content joins one live turn. */
	turnStarted(): void {
		if (!this.sharing) return;
		const sequence = enqueue(
			this.state,
			{ sessionUpdate: "state_update", state: "running" },
			{ save: saveState },
		);
		this.turnSequence = sequence;
		this.state.lastTurnSequence = sequence;
		saveState(this.state);
		void this.flush();
	}

	/** A turn ended, however it ended. */
	turnEnded(): void {
		if (!this.sharing) return;
		const turnSequence = this.turnSequence;
		if (turnSequence === undefined) return;
		this.record({ sessionUpdate: "state_update", state: "idle" }, turnSequence);
		this.turnSequence = undefined;
	}

	/** Record the session's name as the thread's title, once per change. */
	titleChanged(name: string | undefined): void {
		if (!this.sharing || !name) return;
		if (this.state.title === name) return;
		this.state.title = name;
		this.record({ sessionUpdate: "session_info_update", title: name });
	}

	/**
	 * Append the session's history to a thread that was just created.
	 *
	 * Only the newest part is exported: a thread that starts with a hundred
	 * thousand tokens of transcript takes a long time to send and is never read
	 * again. One notice names what was left out and how to read it.
	 */
	snapshot(): void {
		const plan = snapshotUpdates(this.ctx.sessionManager.getEntries(), { root: this.state.checkout });
		const untouched = (): void => {};
		if (plan.omitted > 0 && this.state.threadId) {
			enqueue(
				this.state,
				{
					sessionUpdate: "agent_message",
					messageId: `${this.state.externalId}:history`,
					content: [{ type: "text", text: historyNotice(plan.omitted, plan.total, this.state.threadId) }],
				},
				{ save: untouched },
			);
		}
		for (const update of plan.updates) {
			enqueue(this.state, update, { save: untouched });
		}
		saveState(this.state);
	}

	/** Create or find this session's thread, publish it, and start recording. */
	async share(ctx: ExtensionContext): Promise<void> {
		if (this.sharing && this.state.threadId) {
			if (this.state.visibility === "organization") {
				this.report(`Already shared with your organization: ${this.state.url ?? this.state.threadId}`, "info");
				return;
			}
			// A thread that already syncs can still be widened: only the other
			// direction needs care, because invites survive and people may have read it.
			await verifyContract();
			await deltaJson(["thread", "share", this.state.threadId, "--visibility", "organization"]);
			this.state.visibility = "organization";
			saveState(this.state);
			this.report(`Shared with your organization: ${this.state.url ?? this.state.threadId}`, "info");
			return;
		}
		await verifyContract();
		const organization = await currentOrganization();
		if (!organization) {
			throw new DeltaError(
				"organization_required",
				"Select an organization in Delta first: `delta org list` shows them.",
			);
		}
		let visibility: "private" | "organization" = "private";
		if (ctx.hasUI) {
			const choice = await ctx.ui.select("Who can open this Delta thread?", [
				"Just me",
				"My organization",
				"Cancel",
			]);
			if (!choice || choice === "Cancel") return;
			visibility = choice === "My organization" ? "organization" : "private";
		}
		const created = await deltaJson<{ thread_id?: string; url?: string }>(
			[
				"thread",
				"create",
				"--source",
				SOURCE,
				"--external-id",
				this.state.externalId,
				"--organization",
				organization,
				"--visibility",
				visibility,
			],
			{ cwd: this.ctx.cwd },
		);
		if (!created.thread_id) throw new DeltaError("command_failed", "Delta did not return a thread id");
		this.state.threadId = created.thread_id;
		this.state.url = created.url;
		this.state.visibility = visibility;
		saveState(this.state);
		await this.attachCheckout();
		this.snapshot();
		this.startWatch();
		// Report as soon as the thread exists and is watching. Backfilling the
		// session is local work plus a network upload, so it must not hold the
		// command (and the session's input) until every record is acknowledged.
		const queued = this.state.pending.length;
		this.report(
			`Recording into Delta (${visibility === "organization" ? "shared with your organization" : "just me"}): ${
				this.state.url ?? this.state.threadId
			}${queued ? ` — sending ${queued} record${queued === 1 ? "" : "s"} from this session` : ""}`,
			"info",
		);
		void this.flush();
	}

	/** Join a thread someone shared, and work in its mounted checkouts. */
	async join(link: string): Promise<void> {
		if (!link) throw new DeltaError("invalid_reference", "Pass the thread's share link or id");
		await verifyContract();
		const owner = `${SOURCE}-${this.state.externalId}`;
		const child = spawn(
			DELTA_BIN,
			["--json", "thread", "mount", link, "--owner", owner],
			{ cwd: this.ctx.cwd, stdio: ["ignore", "pipe", "pipe"] },
		);
		this.mounts.push(child);
		const ready = await new Promise<{ thread_id?: string; directory?: string }>((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error("Delta did not finish mounting the thread")), 60_000);
			readLines(child, (line) => {
				try {
					const value = JSON.parse(line) as { directory?: string; thread_id?: string };
					if (value.directory) {
						clearTimeout(timer);
						resolve(value);
					}
				} catch {
					/* keep waiting for the ready line */
				}
			});
			child.on("close", (code) => {
				clearTimeout(timer);
				reject(new Error(`thread mount exited (${code})`));
			});
		});
		this.state.threadId = ready.thread_id ?? link;
		this.state.directory = ready.directory;
		saveState(this.state);
		this.startWatch();
		// Pi answers tool paths against the process working directory and gives
		// extensions no way to move it, so point at the joined checkout instead of
		// pretending the session is already in it.
		this.report(
			`Joined ${this.state.threadId}. Delta placed the thread's files in ${ready.directory}.\n` +
				`Pi cannot change directory mid-session, so start a session there: cd ${ready.directory} && pi`,
			"info",
		);
	}

	/**
	 * Make this thread private again, keeping recorded activity and invites.
	 *
	 * Delta keeps syncing, so recording and the watch carry on; only the
	 * organization's access goes away. People already invited keep theirs, which
	 * is why this is not the inverse of sharing with a team.
	 */
	async unshare(): Promise<void> {
		if (!this.state.threadId) {
			throw new DeltaError("not_shared", "This session has no Delta thread yet. Run `/delta share` first.");
		}
		await verifyContract();
		await deltaJson(["thread", "unshare", this.state.threadId]);
		this.state.visibility = "private";
		saveState(this.state);
		this.report(
			"This thread is private. Explicitly invited people still have access, and recording continues.",
			"info",
		);
	}

	/** Stop recording and release this session's Delta child processes. */
	async leave(): Promise<void> {
		await this.shutdown();
		this.state.threadId = undefined;
		this.state.url = undefined;
		this.state.worktreeReference = undefined;
		this.state.checkout = undefined;
		this.state.directory = undefined;
		saveState(this.state);
	}

	/** Send anything still queued, then stop every child process. */
	async shutdown(): Promise<void> {
		this.stopping = true;
		if (this.retryTimer) clearTimeout(this.retryTimer);
		this.retryTimer = undefined;
		if (this.sharing) {
			await Promise.race([this.flush(), new Promise((resolve) => setTimeout(resolve, 5_000))]);
		}
		this.watch?.kill("SIGTERM");
		this.watch = undefined;
		for (const mount of this.mounts) mount.kill("SIGTERM");
		this.mounts = [];
	}

	/** What a person needs to see about this session's thread. */
	statusText(): string {
		if (!this.state.threadId) return "Not recording into Delta. Run `/delta share` to start.";
		const lines = [
			`Thread: ${this.state.threadId}`,
			this.state.url ? `Link: ${this.state.url}` : undefined,
			`Audience: ${this.state.visibility ?? "unknown"}`,
			`Next sequence: ${this.state.next} (${this.state.pending.length} waiting)`,
			this.state.directory ? `Working directory: ${this.state.directory}` : undefined,
			this.state.worktreeReference ? `Worktree: ${this.state.worktreeReference}` : undefined,
			this.watch ? "Watching for Delta activity." : "Not watching for Delta activity.",
		];
		return lines.filter(Boolean).join("\n");
	}

	private record(update: Update, turnSequence?: number): void {
		enqueue(this.state, update, { turnSequence: turnSequence ?? this.turnSequence, save: saveState });
		void this.flush();
	}

	/**
	 * Deliver the outbox in order, one batch at a time. Records stay on disk
	 * until Delta confirms them, so an interrupted send is retried unchanged.
	 */
	flush(): Promise<void> {
		this.queue = this.queue.then(() => this.drain()).catch((error) => this.failed(error));
		return this.queue;
	}

	private async drain(): Promise<void> {
		if (!this.state.threadId) return;
		while (this.state.pending.length) {
			const [batch] = batches(this.state.pending);
			if (!batch?.length) return;
			const args = [
				"--json",
				"thread",
				"append",
				this.state.threadId,
				"--source",
				SOURCE,
				"--external-id",
				this.state.externalId,
				"--producer-name",
				PRODUCER_NAME,
				"--acknowledge",
				this.state.visibility === "organization" ? "server" : "local",
			];
			const result = await runDelta(args, { stdin: batch.map((record) => record.line).join("") });
			const receipts = parseReceipts(result.stdout);
			if (!receipts.length) {
				const failure =
					[...result.stdout.trim().split("\n")].reverse().reduce<DeltaError | undefined>((found, line) => {
						if (found) return found;
						try {
							return envelopeError(JSON.parse(line));
						} catch {
							return undefined;
						}
					}, undefined) ??
					new DeltaError("process_failed", result.stderr.trim() || `append exited ${result.code}`);
				throw failure;
			}
			const acknowledged = new Set(receipts.map((receipt) => receipt.sequence));
			const fenced = receipts.filter(
				(receipt) => receipt.disposition === "fenced" && receipt.turn_sequence !== null,
			);
			this.state.pending = this.state.pending.filter((record) => !acknowledged.has(record.sequence));
			saveState(this.state);
			this.retryDelay = RETRY_MIN_MS;
			if (fenced.length) this.superseded();
		}
	}

	private failed(error: unknown): void {
		if (this.stopping) return;
		this.report(`Delta recording is paused: ${describe(error)}`, "warning");
		if (error instanceof DeltaError && error.retryable === false) return;
		const delay = this.retryDelay;
		this.retryDelay = Math.min(this.retryDelay * 2, RETRY_MAX_MS);
		this.retryTimer = setTimeout(() => {
			this.retryTimer = undefined;
			void this.flush();
		}, delay);
	}

	/** Someone else took the turn: stop Pi's local run without undoing its tools. */
	private superseded(): void {
		this.report("Someone else took over this Delta turn; stopping Pi's turn.", "warning");
		this.turnSequence = undefined;
		this.ctx.abort();
	}

	private async attachCheckout(): Promise<void> {
		try {
			const top = await this.pi.exec("git", ["rev-parse", "--show-toplevel"], { cwd: this.ctx.cwd });
			if (top.code !== 0) {
				this.report("Not a Git checkout, so no files are shared. Conversation recording continues.", "warning");
				return;
			}
			const checkout = top.stdout.trim() || this.ctx.cwd;
			const created = await deltaJson<{ reference?: string }>(["worktree", "create", checkout], {
				cwd: checkout,
			});
			if (!created.reference) return;
			await deltaJson(["worktree", "attach", created.reference, "--thread", this.state.threadId!], {
				cwd: checkout,
			});
			this.state.worktreeReference = created.reference;
			this.state.checkout = checkout;
			saveState(this.state);
			this.startMount(created.reference, checkout, true);
		} catch (error) {
			this.report(`Could not share files with Delta: ${describe(error)}`, "warning");
		}
	}

	/** Keep a checkout syncing for as long as this session runs. */
	private startMount(reference: string, target: string, existingCheckout: boolean): void {
		const args = ["--json", "worktree", "mount", reference, target];
		if (existingCheckout) args.push("--existing-checkout");
		const child = spawn(DELTA_BIN, args, { cwd: this.ctx.cwd, stdio: ["ignore", "pipe", "pipe"] });
		this.mounts.push(child);
		readLines(child, () => {});
		child.on("close", (code) => {
			this.mounts = this.mounts.filter((mount) => mount !== child);
			if (!this.stopping && code !== 0) {
				this.report(`Delta stopped syncing files (mount exited ${code}).`, "warning");
			}
		});
	}

	/** Follow the thread for teammates' activity and turn supersession. */
	private startWatch(): void {
		if (!this.state.threadId || this.watch) return;
		this.live = false;
		const child = spawn(
			DELTA_BIN,
			[
				"--json",
				"thread",
				"watch",
				this.state.threadId,
				"--source",
				SOURCE,
				"--external-id",
				this.state.externalId,
				"--participate",
				PRODUCER_NAME,
			],
			{ cwd: this.state.checkout ?? this.ctx.cwd, stdio: ["ignore", "pipe", "pipe"] },
		);
		this.watch = child;
		let retry = 3_000;
		readLines(child, (line) => this.watchEvent(line));
		child.on("close", () => {
			this.watch = undefined;
			if (this.stopping || !this.sharing) return;
			this.retryTimer = setTimeout(() => {
				this.retryTimer = undefined;
				this.startWatch();
			}, retry);
			retry = Math.min(retry * 2, 30_000);
		});
	}

	private watchEvent(line: string): void {
		const event = parseWatchEvent(line);
		if (!event) return;
		switch (event.type) {
			case "live":
				this.live = true;
				return;
			case "item": {
				// Only activity after `live` is new; the snapshot that precedes it is history.
				if (!this.live || !MESSAGE_KINDS.has(event.item.kind)) return;
				const text = itemText(event.item.content);
				if (!text?.trim()) return;
				this.pi.sendMessage({
					customType: "delta",
					content: remoteText(event.item.kind, event.item.author, text),
					display: true,
				});
				return;
			}
			case "comment":
				this.pi.sendMessage({
					customType: "delta",
					content: `**${authorName(event.comment.author)}** commented in Delta: ${event.comment.text}`,
					display: true,
				});
				return;
			case "producer.turn":
				if (event.status === "superseded") this.superseded();
				return;
			case "error":
				this.report(`Delta stopped watching: ${event.error.message}`, "warning");
				return;
			default:
				return;
		}
	}

	private report(message: string, type: "info" | "warning" | "error"): void {
		if (message === this.lastReported) return;
		this.lastReported = message;
		if (this.ctx.hasUI) this.ctx.ui.notify(message, type);
		else console.error(`delta: ${message}`);
	}
}

/** A short, safe description of a failure. */
function describe(error: unknown): string {
	if (error instanceof DeltaError) return error.message;
	return error instanceof Error ? error.message : String(error);
}

// ============================================================================
// Extension entry
// ============================================================================

let current: DeltaSession | undefined;

const HELP = [
	"`/delta share` — publish this Pi session as a Delta thread (or share it with your organization)",
	"`/delta join <link>` — work in a thread someone shared with you",
	"`/delta status` — thread, audience, and pending records for this session",
	"`/delta sync` — send records that are still queued",
	"`/delta unshare` — make this thread private again; invited people keep access",
	"`/delta leave` — stop recording and release this session's Delta mounts",
].join("\n");

export default function deltaExtension(pi: ExtensionAPI): void {
	pi.on("session_start", async (event, ctx) => {
		current = new DeltaSession(pi, ctx);
		await current.resume(event.reason);
	});

	pi.on("session_shutdown", async () => {
		await current?.shutdown();
		current = undefined;
	});

	pi.on("message_end", (event) => {
		const message = event.message as { role?: string; timestamp?: number } | undefined;
		if (!message?.role) return;
		// A stable id per message: the outbox keeps retries identical anyway, and
		// this keeps Delta's rows distinct within one session.
		current?.recordMessage(`m${message.timestamp ?? Date.now()}`, event.message);
	});

	// Pi's own `turn_start`/`turn_end` fire per model response, so one prompt with
	// tool calls would open several Delta turns. A run is one Delta turn instead.
	pi.on("agent_start", () => {
		current?.turnStarted();
	});

	pi.on("agent_settled", () => {
		current?.turnEnded();
	});

	pi.on("session_info_changed", (event) => {
		current?.titleChanged(event.name);
	});

	pi.registerCommand("delta", {
		description: "Share this Pi session with Delta, or join a Delta thread",
		handler: async (args, ctx) => {
			const session = current ?? (current = new DeltaSession(pi, ctx));
			const [command, ...rest] = args.trim().split(/\s+/).filter(Boolean);
			try {
				switch (command) {
					case "share":
						await session.share(ctx);
						return;
					case "join":
						await session.join(rest.join(" "));
						return;
					case "status":
						ctx.ui.notify(session.statusText(), "info");
						return;
					case "sync":
						await session.flush();
						ctx.ui.notify(session.statusText(), "info");
						return;
					case "leave":
						await session.leave();
						ctx.ui.notify("Stopped recording into Delta.", "info");
						return;
			case "unshare":
				await session.unshare();
				return;
					default:
						ctx.ui.notify(HELP, "info");
						return;
				}
			} catch (error) {
				ctx.ui.notify(`delta: ${describe(error)}`, "error");
			}
		},
	});
}
