/**
 * Check that activity from Delta reaches Pi.
 *
 * Shares a session, appends a message as a *different* producer, and asserts the
 * session hands it to Pi — first without starting a turn, then with `autoTurn`
 * on. Deletes the thread and the session's outbox afterwards.
 *
 * Run: `bun run scripts/delivery-smoke.ts`.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DeltaError, DeltaSession, deltaJson, runDelta, stateFile, verifyContract } from "../delta";

const sessionId = `delivery-${Date.now().toString(36)}`;
const otherId = `${sessionId}-other`;
const root = path.join(os.tmpdir(), "delta-pi-delivery");
let threadId: string | undefined;

type Sent = { content: unknown; options?: { triggerTurn?: boolean; deliverAs?: string } };
const sent: Sent[] = [];

const pi = {
	sendMessage: (message: { content: unknown }, options?: Sent["options"]) => sent.push({ content: message.content, options }),
	on: () => {},
	registerCommand: () => {},
	exec: async () => ({ code: 1, stdout: "", stderr: "", killed: false }),
};

const ctx = {
	cwd: root,
	hasUI: false,
	abort: () => {},
	setStatus: () => {},
	notify: () => {},
	sessionManager: { getSessionId: () => sessionId, getEntries: () => [] },
};

/** Append one message to the thread as a producer that is not this session. */
async function appendFromOther(text: string, sequence: number): Promise<void> {
	const record = JSON.stringify({
		schemaVersion: 1,
		sequence,
		update: { sessionUpdate: "user_message", messageId: `other-${sequence}`, content: [{ type: "text", text }] },
	});
	const result = await runDelta(
		[
			"--json",
			"thread",
			"append",
			threadId!,
			"--source",
			"other-agent",
			"--external-id",
			otherId,
			"--acknowledge",
			"local",
		],
		{ stdin: `${record}\n` },
	);
	if (result.code !== 0) throw new Error(`append failed: ${result.stdout}${result.stderr}`);
}

async function waitFor<T>(what: string, check: () => T | undefined, timeoutMs = 20_000): Promise<T> {
	const started = Date.now();
	while (Date.now() - started < timeoutMs) {
		const value = check();
		if (value !== undefined) return value;
		await new Promise((resolve) => setTimeout(resolve, 250));
	}
	throw new Error(`timed out waiting for ${what}`);
}

const session = new DeltaSession(pi as never, ctx as never);

try {
	fs.mkdirSync(root, { recursive: true });
	await verifyContract();
	await session.share(ctx as never);
	threadId = session.statusText().match(/Thread: (\S+)/)?.[1];
	if (!threadId) throw new Error("share did not report a thread id");
	// The watch starts with `ready`, the thread's items, then `live`.
	await waitFor("the watch to start", () => (session.statusText().includes("Watching") ? true : undefined));

	await appendFromOther("Can you also update the docs?", 1);
	const first = await waitFor("the first delivered message", () => sent[0]);
	if (!String(first.content).includes("Can you also update the docs?")) {
		throw new Error(`delivered the wrong content: ${String(first.content)}`);
	}
	if (first.options?.triggerTurn) throw new Error("a deferred message must not start a turn");
	console.log(`deferred delivery works: ${JSON.stringify(first.content).slice(0, 80)}`);

	session.setAutoTurn(true);
	await appendFromOther("Please answer this one.", 2);
	const second = await waitFor("the second delivered message", () => sent[1]);
	if (!String(second.content).includes("Please answer this one.")) {
		throw new Error(`delivered the wrong content: ${String(second.content)}`);
	}
	if (second.options?.triggerTurn !== true) throw new Error("autoTurn should start a turn");
	console.log(`auto-turn delivery works: ${JSON.stringify(second.options)}`);
} catch (error) {
	console.error("delivery smoke failed:", error instanceof DeltaError ? error.message : error);
	process.exitCode = 1;
} finally {
	await session.shutdown();
	if (threadId) {
		await runDelta(["--json", "thread", "delete", threadId, "--force"]);
		console.log(`deleted thread ${threadId}`);
	}
	fs.rmSync(stateFile(sessionId), { force: true });
	fs.rmSync(root, { recursive: true, force: true });
}
