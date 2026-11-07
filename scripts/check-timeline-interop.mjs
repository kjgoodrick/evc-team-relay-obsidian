// Optional synthetic host check against the user's Time & Line source checkout.
// No vault, services or plugin installation is used. Run after npm ci in both repos.
import { build } from "esbuild";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const fork = process.argv[2] && resolve(process.argv[2]);
if (!fork) throw new Error("Usage: node scripts/check-timeline-interop.mjs /path/to/obsidian-time-and-line-planning");
const requireFork = createRequire(join(fork, "package.json"));
const happy = requireFork.resolve("happy-dom");
const temp = await mkdtemp(join(tmpdir(), "relay-timeline-interop-"));
try {
	const outfile = join(temp, "check.mjs");
	await build({ entryPoints: [join(root, "scripts/fixtures/timeline-interop.mjs")], outfile, bundle: true, platform: "node", format: "esm",
		external: [happy], alias: {
			"happy-dom": happy,
			"timeline-view": join(fork, "src/SabidurianView.ts"),
			"sequence-view": join(fork, "src/SequenceView.ts"),
			"timeline-bridge": join(fork, "src/collaboration/CollaborationBridge.ts"),
			"timeline-inspector": join(fork, "src/interaction/TaskInspector.ts"),
			"timeline-test-host": join(fork, "tests/obsidian-mock.ts"),
			obsidian: join(root, "scripts/fixtures/timeline-host.mjs"),
		} });
	const result = spawnSync(process.execPath, [outfile], { stdio: "inherit", timeout: 30_000 });
	if (result.error) throw result.error;
	process.exitCode = result.status ?? 1;
} finally { await rm(temp, { recursive: true, force: true }); }
