import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock tigerbeetle-node before importing the client
const mockCreateAccounts = vi.fn();
const mockCreateTransfers = vi.fn();
const mockLookupAccounts = vi.fn();
const mockLookupTransfers = vi.fn();
const mockDestroy = vi.fn();

const mockClient = {
	createAccounts: mockCreateAccounts,
	createTransfers: mockCreateTransfers,
	lookupAccounts: mockLookupAccounts,
	lookupTransfers: mockLookupTransfers,
	destroy: mockDestroy,
};

vi.mock("tigerbeetle-node", () => ({
	createClient: vi.fn(() => mockClient),
	AccountFlags: { debits_must_not_exceed_credits: 1 << 2, history: 1 << 5 },
	TransferFlags: { pending: 1, post_pending_transfer: 2, void_pending_transfer: 4 },
	CreateAccountError: { exists: 1 },
	CreateTransferError: {
		exceeds_credits: 22,
		overflows_debits: 30,
		overflows_debits_pending: 31,
	},
	amount_max: (1n << 128n) - 1n,
}));

import {
	GovernTBClient,
	TBTransferError,
	LEDGER_USERTOKENS,
	CODE_USER_WALLET,
	CODE_PLATFORM_TREASURY,
	XFER_SPEND,
} from "../../src/ledger/client.js";

describe("GovernTBClient", () => {
	let client: GovernTBClient;

	beforeEach(() => {
		vi.clearAllMocks();
		vi.useFakeTimers();
		client = new GovernTBClient({ addresses: ["3000"] });
	});

	afterEach(() => {
		client.destroy();
		vi.useRealTimers();
	});

	describe("deriveAccountId", () => {
		it("returns deterministic bigint for same userId", () => {
			const id1 = GovernTBClient.deriveAccountId("user_123");
			const id2 = GovernTBClient.deriveAccountId("user_123");
			expect(id1).toBe(id2);
		});

		it("returns different IDs for different users", () => {
			const id1 = GovernTBClient.deriveAccountId("user_123");
			const id2 = GovernTBClient.deriveAccountId("user_456");
			expect(id1).not.toBe(id2);
		});

		it("returns a bigint", () => {
			const id = GovernTBClient.deriveAccountId("test");
			expect(typeof id).toBe("bigint");
		});
	});

	describe("createUserWallet", () => {
		it("creates account and returns account ID", async () => {
			mockCreateAccounts.mockResolvedValueOnce([]);
			const id = await client.createUserWallet("user_1");
			expect(typeof id).toBe("bigint");
			expect(mockCreateAccounts).toHaveBeenCalledOnce();
		});

		it("returns cached ID on second call", async () => {
			mockCreateAccounts.mockResolvedValueOnce([]);
			const id1 = await client.createUserWallet("user_2");
			const id2 = await client.createUserWallet("user_2");
			expect(id1).toBe(id2);
			expect(mockCreateAccounts).toHaveBeenCalledTimes(1);
		});

		it("handles account-already-exists gracefully", async () => {
			mockCreateAccounts.mockResolvedValueOnce([{ index: 0, result: 1 }]); // exists
			const id = await client.createUserWallet("user_3");
			expect(typeof id).toBe("bigint");
		});

		it("throws on other creation errors", async () => {
			mockCreateAccounts.mockResolvedValueOnce([{ index: 0, result: 99 }]);
			await expect(client.createUserWallet("user_4")).rejects.toThrow(
				"Failed to create account",
			);
		});
	});

	describe("createPendingTransfer", () => {
		it("creates transfer and returns transfer ID", async () => {
			mockCreateTransfers.mockResolvedValueOnce([]);
			const id = await client.createPendingTransfer({
				debitAccountId: 1n,
				creditAccountId: 2n,
				amount: 100,
				code: XFER_SPEND,
			});
			expect(typeof id).toBe("bigint");
			expect(mockCreateTransfers).toHaveBeenCalledOnce();
		});

		it("throws TBTransferError on failure", async () => {
			mockCreateTransfers.mockResolvedValueOnce([{ index: 0, result: 22 }]);
			await expect(
				client.createPendingTransfer({
					debitAccountId: 1n,
					creditAccountId: 2n,
					amount: 100,
					code: XFER_SPEND,
				}),
			).rejects.toThrow(TBTransferError);
		});
	});

	describe("postTransfer", () => {
		it("posts pending transfer", async () => {
			mockCreateTransfers.mockResolvedValueOnce([]);
			const id = await client.postTransfer(123n);
			expect(typeof id).toBe("bigint");
		});

		it("throws on failure", async () => {
			mockCreateTransfers.mockResolvedValueOnce([{ index: 0, result: 5 }]);
			await expect(client.postTransfer(123n)).rejects.toThrow("Post transfer failed");
		});
	});

	describe("voidTransfer", () => {
		it("voids pending transfer", async () => {
			mockCreateTransfers.mockResolvedValueOnce([]);
			const id = await client.voidTransfer(123n);
			expect(typeof id).toBe("bigint");
		});

		it("throws on failure", async () => {
			mockCreateTransfers.mockResolvedValueOnce([{ index: 0, result: 5 }]);
			await expect(client.voidTransfer(123n)).rejects.toThrow("Void transfer failed");
		});
	});

	describe("lookupAccounts", () => {
		it("returns accounts from TB", async () => {
			const mockAccount = {
				id: 1n,
				credits_posted: 1000n,
				debits_posted: 200n,
				debits_pending: 50n,
			};
			mockLookupAccounts.mockResolvedValueOnce([mockAccount]);
			const accounts = await client.lookupAccounts([1n]);
			expect(accounts).toHaveLength(1);
			expect(accounts[0]!.id).toBe(1n);
		});
	});

	describe("lookupBalance", () => {
		it("returns available, pending, and total", async () => {
			mockLookupAccounts.mockResolvedValueOnce([
				{
					id: 1n,
					credits_posted: 1000n,
					debits_posted: 200n,
					debits_pending: 50n,
					credits_pending: 0n,
				},
			]);
			const bal = await client.lookupBalance(1n);
			expect(bal.total).toBe(800); // 1000 - 200
			expect(bal.pending).toBe(50);
			expect(bal.available).toBe(750); // 800 - 50
		});

		it("throws if account not found", async () => {
			mockLookupAccounts.mockResolvedValueOnce([]);
			await expect(client.lookupBalance(999n)).rejects.toThrow("Account not found");
		});
	});

	describe("lookupTransfer", () => {
		it("returns transfer when found", async () => {
			const mockTransfer = { id: 100n, amount: 500n };
			mockLookupTransfers.mockResolvedValueOnce([mockTransfer]);
			const result = await client.lookupTransfer(100n);
			expect(result).toEqual(mockTransfer);
		});

		it("returns null when not found", async () => {
			mockLookupTransfers.mockResolvedValueOnce([]);
			const result = await client.lookupTransfer(999n);
			expect(result).toBeNull();
		});
	});

	describe("destroy", () => {
		it("destroys the underlying client", () => {
			client.destroy();
			expect(mockDestroy).toHaveBeenCalledOnce();
		});
	});

	describe("treasury", () => {
		it("setTreasuryId stores the ID", () => {
			client.setTreasuryId(42n);
			expect(client.getTreasuryId()).toBe(42n);
		});

		it("getTreasuryId throws when not initialized", () => {
			expect(() => client.getTreasuryId()).toThrow("Treasury not initialized");
		});
	});

	describe("account mapping", () => {
		it("setAccountMapping and getAccountId round-trip", () => {
			client.setAccountMapping("user_x", 99n);
			expect(client.getAccountId("user_x")).toBe(99n);
		});

		it("getAccountId throws for unknown user", () => {
			expect(() => client.getAccountId("unknown")).toThrow(
				"No TigerBeetle account for user",
			);
		});
	});

	describe("constants", () => {
		it("LEDGER_USERTOKENS is 1", () => {
			expect(LEDGER_USERTOKENS).toBe(1);
		});

		it("account codes are distinct", () => {
			expect(CODE_USER_WALLET).not.toBe(CODE_PLATFORM_TREASURY);
		});
	});
});
