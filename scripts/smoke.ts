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
import { DeltaError, DeltaSession, deltaJson, runDelta, stateFile, verifyContract } from "../delta";

const sessionId = `smoke-${Date.now().toString(36)}`;

/**
 * Scratch space that survives between runs.
 *
 * A fresh checkout per run made Delta register a new worktree every time, and
 * the CLI has no command to delete one, so it accumulates. The path here is
 * stable: repeated runs reuse the same checkout and therefore the same worktree.
 */
const root = path.join(os.tmpdir(), "delta-pi-smoke");
const checkout = path.join(root, "checkout");
const remote = path.join(root, "remote.git");
/** Worktrees are only created for the file-sharing path, which is opt-in. */
const withWorktree = process.argv.includes("--worktree") || process.env.SMOKE_WORKTREE === "1";
let threadId: string | undefined;

/** A Git checkout Delta can attach: it needs a remote that already has the work. */
function makeRepository(): void {
	fs.mkdirSync(root, { recursive: true });
	if (!fs.existsSync(remote)) execFileSync("git", ["init", "-q", "--bare", remote]);
	if (!fs.existsSync(path.join(checkout, ".git"))) {
		fs.mkdirSync(checkout, { recursive: true });
		execFileSync("git", ["init", "-q"], { cwd: checkout });
		execFileSync("git", ["config", "user.email", "smoke@example.com"], { cwd: checkout });
		execFileSync("git", ["config", "user.name", "Smoke"], { cwd: checkout });
		fs.writeFileSync(path.join(checkout, "README.md"), "# smoke\n");
		execFileSync("git", ["add", "."], { cwd: checkout });
		execFileSync("git", ["commit", "-qm", "initial"], { cwd: checkout });
		execFileSync("git", ["remote", "add", "origin", remote], { cwd: checkout });
		execFileSync("git", ["push", "-q", "origin", "HEAD:main"], { cwd: checkout });
	}
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
	cwd: withWorktree ? checkout : root,
	hasUI: false,
	abort: () => {},
	sessionManager: {
		getSessionId: () => sessionId,
		getEntries: () => history(),
	},
};

/** `--long` fills the session with about 100k tokens of history. */
const historyCount = Number(process.env.SMOKE_HISTORY ?? 0) || (process.argv.includes("--long") ? 300 : 0);
const long = historyCount > 0;

function history(): unknown[] {
	if (!long) {
		return [
			{
				type: "message",
				id: "history-1",
				message: { role: "user", content: "Earlier question from the session history." },
			},
		];
	}
	return Array.from({ length: historyCount }, (_, index) => ({
		type: "message",
		id: `history-${index}`,
		message: {
			role: index % 2 === 0 ? "user" : "assistant",
			content: [{ type: "text", text: `history ${index} ${"context ".repeat(180)}` }],
		},
	}));
}

const session = new DeltaSession(pi as never, ctx as never);

try {
	if (withWorktree) makeRepository(); else fs.mkdirSync(root, { recursive: true });
	await verifyContract();

	const shareStarted = Date.now();
	await session.share(ctx as never);
	console.log(`share returned in ${Date.now() - shareStarted} ms`);
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
	// An edit carries a unified patch, which should record as a diff, and a huge
	// command output should be clipped rather than sent whole.
	session.recordMessage("live-4", {
		role: "assistant",
		content: [{ type: "toolCall", id: "call-2", name: "edit", arguments: { path: path.join(checkout, "README.md") } }],
	});
	session.recordMessage("live-5", {
		role: "toolResult",
		toolCallId: "call-2",
		toolName: "edit",
		content: [{ type: "text", text: "edited" }],
		details: {
			patch: [
				"diff --git a/README.md b/README.md",
				"--- a/README.md",
				"+++ b/README.md",
				"@@ -1 +1,2 @@",
				" # smoke",
				"+recorded by delta-pi",
				"",
			].join("\n"),
			diff: "1: # smoke\n+2: recorded by delta-pi",
		},
		isError: false,
	});
	session.recordMessage("live-6", {
		role: "assistant",
		content: [{ type: "toolCall", id: "call-3", name: "bash", arguments: { command: "yes | head -c 400000" } }],
	});
	session.recordMessage("live-7", {
		role: "toolResult",
		toolCallId: "call-3",
		toolName: "bash",
		content: [{ type: "text", text: "y\n".repeat(200_000) }],
		details: { stdout: "y\n".repeat(200_000) },
		isError: false,
	});
	session.turnEnded();
	session.turnEnded();
	await session.flush();
	console.log(`after flush: ${session.statusText().replace(/\n/g, " | ")}`);

	const status = await deltaJson<{
		producer: { next_sequence: number; turn: { status: string } | null };
		visibility: string;
	}>(["thread", "status", threadId, "--source", "pi", "--external-id", sessionId]);
	console.log(`status: visibility=${status.visibility} producer=${JSON.stringify(status.producer)}`);
	if (status.producer.turn?.status !== "finished") throw new Error("the turn did not finish");

	const summary = await deltaJson<{ messages: { number: number }[] }[]>(["thread", "show", threadId, "--format", "summarize"]);	const count = summary[0]?.messages.length ?? 0;
	// `show --messages` reads at most 20 messages per call, like the notice says.
	let shown = "";
	for (let first = 1; first <= count; first += 20) {
		const last = Math.min(first + 19, count);
		shown += JSON.stringify(
			await deltaJson(["thread", "show", threadId, "--format", "messages", "--messages", `${first}-${last}`]),
		);
	}
	const expected = [
		"Please inspect this change.",
		"The change adds validation.",
		"Look at README first.",
		"# smoke",
	];
	if (long) {
		// The oldest history is left out, and the notice says how to read it.
		expected.push(`history ${historyCount - 1} `, "left out of the transcript");
	} else {
		expected.push("Earlier question from the session history.");
	}
	for (const text of expected) {
		if (!shown.includes(text)) throw new Error(`transcript is missing: ${text}`);
	}
	if (!shown.includes("```diff")) throw new Error("the edit was not recorded as a patch");
	if (!shown.includes("more characters]")) throw new Error("the huge tool output was not clipped");
	if (long && shown.includes("history 0 context")) throw new Error("the oldest history was exported");
	console.log(
		`transcript has ${count} messages, the thought, and the tool call` +
			(long ? "; the oldest history was left out and named in a notice" : ""),
	);
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
	// Nothing of this run survives: no thread, no outbox, no scratch checkout.
	fs.rmSync(stateFile(sessionId), { force: true });
	if (withWorktree) fs.rmSync(checkout, { recursive: true, force: true });
	if (withWorktree) fs.rmSync(remote, { recursive: true, force: true });
	fs.rmSync(root, { recursive: true, force: true });
}
