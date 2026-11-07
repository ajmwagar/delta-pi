/**
 * Check that `thread watch` output parses, and that remote activity reads as it
 * should.
 *
 * Creates a private thread, appends one message, then watches it twice: once as
 * this producer (which hides its own items) and once as an observer (which sees
 * everything). Prints the decoded event types and deletes the thread.
 */
import { spawn } from "node:child_process";
import { DeltaSession, type WatchEvent, deltaJson, parseWatchEvent, runDelta, verifyContract } from "../delta";

const sessionId = `watch-smoke-${Date.now().toString(36)}`;
let threadId: string | undefined;

/** Collect decoded events from one watch for a few seconds. */
async function listen(args: string[], seconds: number): Promise<WatchEvent[]> {
	const events: WatchEvent[] = [];
	const child = spawn("delta", ["--json", "thread", "watch", ...args], { stdio: ["ignore", "pipe", "pipe"] });
	let buffer = "";
	child.stdout.setEncoding("utf8");
	child.stdout.on("data", (chunk: string) => {
		buffer += chunk;
		let index = buffer.indexOf("\n");
		while (index >= 0) {
			const event = parseWatchEvent(buffer.slice(0, index));
			if (event) events.push(event);
			buffer = buffer.slice(index + 1);
			index = buffer.indexOf("\n");
		}
	});
	await new Promise((resolve) => setTimeout(resolve, seconds * 1000));
	child.kill("SIGTERM");
	return events;
}

try {
	await verifyContract();
	const created = await deltaJson<{ thread_id?: string }>(
		["thread", "create", "--source", "pi", "--external-id", sessionId, "--organization", await currentOrg(), "--visibility", "private"],
	);
	threadId = created.thread_id;
	if (!threadId) throw new Error("no thread id");

	const record = JSON.stringify({
		schemaVersion: 1,
		sequence: 1,
		update: { sessionUpdate: "user_message", messageId: "watch-1", content: [{ type: "text", text: "Hello from a teammate" }] },
	});
	const appended = await runDelta(
		["--json", "thread", "append", threadId, "--source", "pi", "--external-id", sessionId, "--acknowledge", "local"],
		{ stdin: `${record}\n` },
	);
	if (appended.code !== 0) throw new Error(`append failed: ${appended.stdout}${appended.stderr}`);

	const asProducer = await listen([threadId!, "--source", "pi", "--external-id", sessionId], 3);
	const asObserver = await listen([threadId!], 3);
	const summarise = (events: WatchEvent[]) =>
		events.map((event) =>
			event.type === "item" ? `item:${event.item.kind}:${JSON.stringify(event.item.content.text ?? "")}` : event.type,
		);
	console.log("as producer:", summarise(asProducer).join(" | "));
	console.log("as observer:", summarise(asObserver).join(" | "));
} finally {
	if (threadId) {
		await runDelta(["--json", "thread", "delete", threadId, "--force"]);
		console.log(`deleted thread ${threadId}`);
	}
}

async function currentOrg(): Promise<string> {
	const answer = await deltaJson<{ organizations?: { id: string; current: boolean }[] }>(["org", "list"]);
	const organization = answer.organizations?.find((entry) => entry.current)?.id;
	if (!organization) throw new Error("no current organization");
	return organization;
}
