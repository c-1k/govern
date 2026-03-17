import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	createSnapshot,
	listSnapshots,
	restoreSnapshot,
} from "../../src/snapshot/checkpoint.js";

describe("Checkpoint / Restore", () => {
	let tempDir: string;
	let vaultPath: string;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "govern-snapshot-"));
		vaultPath = tempDir;
	});

	afterEach(async () => {
		await rm(tempDir, { recursive: true, force: true });
	});

	/** Helper to populate a vault with test files */
	async function populateVault(): Promise<void> {
		// audit/
		await mkdir(join(vaultPath, "audit"), { recursive: true });
		await writeFile(join(vaultPath, "audit", "chain.jsonl"), "line1\nline2\n");
		await writeFile(join(vaultPath, "audit", "index.json"), '{"count": 2}');

		// policies/
		await mkdir(join(vaultPath, "policies"), { recursive: true });
		await writeFile(
			join(vaultPath, "policies", "default.json"),
			'{"maxBudget": 50000}',
		);

		// patterns/
		await mkdir(join(vaultPath, "patterns"), { recursive: true });
		await writeFile(join(vaultPath, "patterns", "memory.json"), "[]");

		// govern.config.json
		await writeFile(
			join(vaultPath, "govern.config.json"),
			'{"version": 1}',
		);

		// leases.json
		await writeFile(join(vaultPath, "leases.json"), "{}");

		// Excluded directories
		await mkdir(join(vaultPath, "tigerbeetle"), { recursive: true });
		await writeFile(
			join(vaultPath, "tigerbeetle", "data.tb"),
			"binary-data",
		);

		await mkdir(join(vaultPath, "dlq"), { recursive: true });
		await writeFile(join(vaultPath, "dlq", "dead-letter.jsonl"), "error\n");
	}

	describe("createSnapshot", () => {
		it("captures vault files", async () => {
			await populateVault();

			const meta = await createSnapshot(vaultPath, "test-snap");

			expect(meta.name).toBe("test-snap");
			expect(meta.timestamp).toBeTruthy();
			expect(meta.files).toContain("audit/chain.jsonl");
			expect(meta.files).toContain("audit/index.json");
			expect(meta.files).toContain("policies/default.json");
			expect(meta.files).toContain("patterns/memory.json");
			expect(meta.files).toContain("govern.config.json");
			expect(meta.files).toContain("leases.json");
			expect(meta.size).toBeGreaterThan(0);
		});

		it("excludes tigerbeetle/ and snapshots/ directories", async () => {
			await populateVault();

			// Create a prior snapshot to verify snapshots/ is excluded
			await createSnapshot(vaultPath, "prior-snap");
			const meta = await createSnapshot(vaultPath, "test-snap");

			const hasTB = meta.files.some((f) => f.startsWith("tigerbeetle"));
			const hasSnapshots = meta.files.some((f) => f.startsWith("snapshots"));
			const hasDlq = meta.files.some((f) => f.startsWith("dlq"));

			expect(hasTB).toBe(false);
			expect(hasSnapshots).toBe(false);
			expect(hasDlq).toBe(false);
		});

		it("stores snapshot as JSON with base64 entries", async () => {
			await populateVault();

			await createSnapshot(vaultPath, "encoded-snap");

			const snapFile = join(vaultPath, "snapshots", "encoded-snap.json");
			const raw = await readFile(snapFile, "utf-8");
			const payload = JSON.parse(raw) as {
				meta: { name: string };
				entries: Record<string, string>;
			};

			expect(payload.meta.name).toBe("encoded-snap");
			expect(payload.entries["govern.config.json"]).toBeTruthy();

			// Verify base64 decoding
			const decoded = Buffer.from(
				payload.entries["govern.config.json"]!,
				"base64",
			).toString("utf-8");
			expect(decoded).toBe('{"version": 1}');
		});
	});

	describe("restoreSnapshot", () => {
		it("reverts to captured state", async () => {
			await populateVault();

			// Take snapshot
			await createSnapshot(vaultPath, "restore-test");

			// Modify files
			await writeFile(
				join(vaultPath, "govern.config.json"),
				'{"version": 99}',
			);
			await writeFile(
				join(vaultPath, "audit", "chain.jsonl"),
				"modified-content\n",
			);

			// Restore
			await restoreSnapshot(vaultPath, "restore-test");

			// Verify restoration
			const config = await readFile(
				join(vaultPath, "govern.config.json"),
				"utf-8",
			);
			expect(config).toBe('{"version": 1}');

			const chain = await readFile(
				join(vaultPath, "audit", "chain.jsonl"),
				"utf-8",
			);
			expect(chain).toBe("line1\nline2\n");
		});

		it("restores files even if directories were deleted", async () => {
			await populateVault();
			await createSnapshot(vaultPath, "deleted-dirs");

			// Delete the policies directory
			await rm(join(vaultPath, "policies"), { recursive: true, force: true });

			// Restore
			await restoreSnapshot(vaultPath, "deleted-dirs");

			// Verify policies/ was recreated
			const policy = await readFile(
				join(vaultPath, "policies", "default.json"),
				"utf-8",
			);
			expect(policy).toBe('{"maxBudget": 50000}');
		});
	});

	describe("listSnapshots", () => {
		it("returns all snapshots sorted by timestamp", async () => {
			await populateVault();

			await createSnapshot(vaultPath, "alpha");
			// Small delay to ensure different timestamps
			await new Promise((r) => setTimeout(r, 10));
			await createSnapshot(vaultPath, "beta");
			await new Promise((r) => setTimeout(r, 10));
			await createSnapshot(vaultPath, "gamma");

			const snapshots = await listSnapshots(vaultPath);

			expect(snapshots).toHaveLength(3);
			expect(snapshots[0]!.name).toBe("alpha");
			expect(snapshots[1]!.name).toBe("beta");
			expect(snapshots[2]!.name).toBe("gamma");

			// Verify sorted by timestamp
			for (let i = 1; i < snapshots.length; i++) {
				expect(snapshots[i]!.timestamp >= snapshots[i - 1]!.timestamp).toBe(
					true,
				);
			}
		});

		it("returns empty array when no snapshots exist", async () => {
			const snapshots = await listSnapshots(vaultPath);
			expect(snapshots).toEqual([]);
		});
	});

	describe("named snapshots", () => {
		it("supports creating and restoring multiple named snapshots", async () => {
			await populateVault();

			// Snapshot "v1"
			await createSnapshot(vaultPath, "v1");

			// Modify and snapshot "v2"
			await writeFile(
				join(vaultPath, "govern.config.json"),
				'{"version": 2}',
			);
			await createSnapshot(vaultPath, "v2");

			// Restore v1
			await restoreSnapshot(vaultPath, "v1");
			let config = await readFile(
				join(vaultPath, "govern.config.json"),
				"utf-8",
			);
			expect(config).toBe('{"version": 1}');

			// Restore v2
			await restoreSnapshot(vaultPath, "v2");
			config = await readFile(
				join(vaultPath, "govern.config.json"),
				"utf-8",
			);
			expect(config).toBe('{"version": 2}');
		});
	});
});
