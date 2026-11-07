/**
 * End-to-end check against a real Delta install.
 *
 * Creates a private thread for a throwaway Git repository with a local bare
 * remote, records one turn through DeltaSession, reads the transcript back with
 * `delta thread show`, then deletes the thread and the checkout.
 *
 * Run: `bun run scripts/smoke.ts`. It leaves nothing behind: the thread is
 * private, and the only copy of it is deleted at the end.
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DeltaError, DeltaSession, deltaJson, runDelta, verifyContract } from "../delta";

const sessionId = `smoke-${Date.now().toString(36)}`;
const root = fs.mkdtempSync(path.join(os.tmpdir(), "delta-pi-smoke-"));
const checkout = path.join(root, "checkout");
const remote = path.join(root, "remote.git");
let threadId: string | undefined;

/** A Git checkout Delta can attach: it needs a remote that has the work. */
function makeRepository(): void {
	execFileSync("git", ["init", "-q", "--bare", remote]);
	fs.mkdirSync(checkout);
	execFileSync("git", ["init", "-q"], { cwd: checkout });
	execFileSync("git", ["config", "user.email", "smoke@example.com"], { cwd: checkout });
	execFileSync("git", ["config", "user.name", "Smoke"], { cwd: checkout });
	fs.writeFileSync(path.join(checkout, "README.md"), "# smoke\n");
	execFileSync("git", ["add", "."], { cwd: checkout });
	execFileSync("git", ["commit", "-qm", "initial"], { cwd: checkout });
	execFileSync("git", ["remote", "add", "origin", remote], { cwd: checkout });
	execFileSync("git", ["push", "-q", "origin", "HEAD:main"], { cwd: checkout });
}

const delivered: unknown[] = [];

const pi = {
	sendMessage: (message: unknown) => delivered.push(message),
	exec: async (command: string, args: string[], options?: { cwd?: string }) => {
		try {
			const stdout = execFileSync(command, args, { cwd: options?.cwd, encoding: "utf8" });
			return { code: 0, stdout, stderr: "", killed: false };
		} catch (error) {
			const failure = error as { status?: number; stdout?: string; stderr?: string };
			return {
				code: failure.status ?? 1,
				stdout: failure.stdout ?? "",
				stderr: failure.stderr ?? "",
				killed: false,
			};
		}
	},
	on: () => {},
	registerCommand: () => {},
};

const ctx = {
	cwd: checkout,
	hasUI: false,
	abort: () => {},
	sessionManager: {
		getSessionId: () => sessionId,
		getEntries: () => [
			{
				type: "message",
				id: "history-1",
				message: { role: "user", content: "Earlier question from the session history." },
			},
		],
	},
};

const session = new DeltaSession(pi as never, ctx as never);

try {
	makeRepository();
	await verifyContract();

	await session.share(ctx as never);
	console.log(`shared: ${session.statusText().replace(/\n/g, " | ")}`);
	threadId = session.statusText().match(/Thread: (\S+)/)?.[1];
	if (!threadId) throw new Error("share did not report a thread id");

	session.turnStarted();
	session.recordMessage("live-1", { role: "user", content: "Please inspect this change." });
	session.recordMessage("live-2", {
		role: "assistant",
		content: [
			{ type: "thinking", thinking: "Look at README first." },
			{ type: "text", text: "The change adds validation." },
			{ type: "toolCall", id: "call-1", name: "read", arguments: { path: path.join(checkout, "README.md") } },
		],
	});
	session.recordMessage("live-3", {
		role: "toolResult",
		toolCallId: "call-1",
		toolName: "read",
		content: [{ type: "text", text: "# smoke" }],
		isError: false,
	});
	session.turnEnded();
	await session.flush();
	console.log(`after flush: ${session.statusText().replace(/\n/g, " | ")}`);

	const status = await deltaJson<{
		producer: { next_sequence: number; turn: { status: string } | null };
		visibility: string;
	}>(["thread", "status", threadId, "--source", "pi", "--external-id", sessionId]);
	console.log(`status: visibility=${status.visibility} producer=${JSON.stringify(status.producer)}`);
	if (status.producer.turn?.status !== "finished") throw new Error("the turn did not finish");

	const summary = await deltaJson<{ messages: { number: number }[] }[]>(["thread", "show", threadId, "--format", "summarize"]);
	const count = summary[0]?.messages.length ?? 0;
	const shown = JSON.stringify(
		await deltaJson(["thread", "show", threadId, "--format", "messages", "--messages", `1-${count}`]),
	);
	for (const expected of [
		"Earlier question from the session history.",
		"Please inspect this change.",
		"The change adds validation.",
		"Look at README first.",
		"# smoke",
	]) {
		if (!shown.includes(expected)) throw new Error(`transcript is missing: ${expected}`);
	}
	console.log(`transcript has all ${count} messages, the thought, and the tool call`);
} catch (error) {
	console.error("smoke failed:", error instanceof DeltaError ? error.message : error);
	process.exitCode = 1;
} finally {
	await session.shutdown();
	if (threadId) {
		// Leave nothing behind, even when a check above failed.
		await runDelta(["--json", "thread", "delete", threadId, "--force"]);
		console.log(`deleted thread ${threadId}`);
	}
	fs.rmSync(root, { recursive: true, force: true });
}
