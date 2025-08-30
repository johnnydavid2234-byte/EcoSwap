// SwapMatching.test.ts
import { describe, expect, it, vi, beforeEach } from "vitest";

// Interfaces for type safety
interface ClarityResponse<T> {
  ok: boolean;
  value: T | number; // number for error codes
}

interface SwapDetails {
  proposer: string;
  proposedTo: string;
  offeredItems: number[];
  requestedItems: number[];
  status: string;
  expiration: number;
  timestamp: number;
  parentSwapId: number | null;
  childCounterId: number | null;
}

interface ContractState {
  lastSwapId: number;
  contractOwner: string;
  swaps: Map<number, SwapDetails>;
  userSwaps: Map<string, { swapIds: number[] }>;
  counterOfferCount: Map<number, { count: number }>;
}

// Mock contract implementation
class SwapMatchingMock {
  private state: ContractState = {
    lastSwapId: 0,
    contractOwner: "deployer",
    swaps: new Map(),
    userSwaps: new Map(),
    counterOfferCount: new Map(),
  };

  private ERR_NOT_AUTHORIZED = 100;
  private ERR_INVALID_ITEM = 101;
  private ERR_SWAP_NOT_FOUND = 102;
  private ERR_INVALID_STATUS = 103;
  private ERR_EXPIRED = 104;
  private ERR_INVALID_EXPIRATION = 105;
  private ERR_NOT_PROPOSER = 106;
  private ERR_NOT_PROPOSED_TO = 107;
  private ERR_SELF_SWAP = 108;
  private ERR_EMPTY_ITEMS = 109;
  private ERR_MAX_ITEMS_EXCEEDED = 110;
  private ERR_ALREADY_ACCEPTED = 111;
  private ERR_COUNTER_OFFER_EXISTS = 112;
  private MAX_ITEMS_PER_SIDE = 5;
  private MAX_COUNTER_OFFER_DEPTH = 3;

  private mockBlockHeight = 1000; // Mocked block height for testing

  // Helper to set mock block height
  setMockBlockHeight(height: number) {
    this.mockBlockHeight = height;
  }

  private isRegisteredUser(user: string): boolean {
    return true; // Placeholder
  }

  private validateItems(items: number[]): boolean {
    return items.length > 0 && items.length <= this.MAX_ITEMS_PER_SIDE;
  }

  private appendToUserSwaps(user: string, swapId: number) {
    const current = this.state.userSwaps.get(user) ?? { swapIds: [] };
    current.swapIds.push(swapId);
    if (current.swapIds.length > 100) current.swapIds.shift(); // Simulate max-len
    this.state.userSwaps.set(user, current);
  }

  private emitSwapEvent(_eventType: string, _swapId: number) {
    // Mocked, no-op
  }

  proposeSwap(
    proposedTo: string,
    offeredItems: number[],
    requestedItems: number[],
    expiration: number,
    caller: string
  ): ClarityResponse<number> {
    if (caller === proposedTo) return { ok: false, value: this.ERR_SELF_SWAP };
    if (!this.isRegisteredUser(caller)) return { ok: false, value: this.ERR_NOT_AUTHORIZED };
    if (!this.isRegisteredUser(proposedTo)) return { ok: false, value: this.ERR_NOT_AUTHORIZED };
    if (!this.validateItems(offeredItems)) return { ok: false, value: this.ERR_INVALID_ITEM };
    if (!this.validateItems(requestedItems)) return { ok: false, value: this.ERR_INVALID_ITEM };
    if (!(expiration > this.mockBlockHeight && expiration <= this.mockBlockHeight + 10080)) {
      return { ok: false, value: this.ERR_INVALID_EXPIRATION };
    }

    const newId = this.state.lastSwapId + 1;
    this.state.swaps.set(newId, {
      proposer: caller,
      proposedTo,
      offeredItems,
      requestedItems,
      status: "pending",
      expiration,
      timestamp: this.mockBlockHeight,
      parentSwapId: null,
      childCounterId: null,
    });
    this.appendToUserSwaps(caller, newId);
    this.appendToUserSwaps(proposedTo, newId);
    this.state.lastSwapId = newId;
    this.emitSwapEvent("proposed", newId);
    return { ok: true, value: newId };
  }

  acceptSwap(swapId: number, caller: string): ClarityResponse<boolean> {
    const swap = this.state.swaps.get(swapId);
    if (!swap) return { ok: false, value: this.ERR_SWAP_NOT_FOUND };
    if (swap.proposedTo !== caller) return { ok: false, value: this.ERR_NOT_PROPOSED_TO };
    if (swap.status !== "pending") return { ok: false, value: this.ERR_INVALID_STATUS };
    if (this.mockBlockHeight >= swap.expiration) return { ok: false, value: this.ERR_EXPIRED };
    if (swap.childCounterId !== null) return { ok: false, value: this.ERR_COUNTER_OFFER_EXISTS };

    swap.status = "accepted";
    this.state.swaps.set(swapId, swap);
    this.emitSwapEvent("accepted", swapId);
    return { ok: true, value: true };
  }

  cancelSwap(swapId: number, caller: string): ClarityResponse<boolean> {
    const swap = this.state.swaps.get(swapId);
    if (!swap) return { ok: false, value: this.ERR_SWAP_NOT_FOUND };
    if (swap.proposer !== caller && swap.proposedTo !== caller) return { ok: false, value: this.ERR_NOT_AUTHORIZED };
    if (swap.status !== "pending") return { ok: false, value: this.ERR_INVALID_STATUS };

    swap.status = "cancelled";
    this.state.swaps.set(swapId, swap);
    this.emitSwapEvent("cancelled", swapId);
    return { ok: true, value: true };
  }

  counterOffer(
    originalSwapId: number,
    newOfferedItems: number[],
    newRequestedItems: number[],
    newExpiration: number,
    caller: string
  ): ClarityResponse<number> {
    const original = this.state.swaps.get(originalSwapId);
    if (!original) return { ok: false, value: this.ERR_SWAP_NOT_FOUND };
    const counterCount = this.state.counterOfferCount.get(originalSwapId)?.count ?? 0;
    if (original.proposedTo !== caller) return { ok: false, value: this.ERR_NOT_PROPOSED_TO };
    if (original.status !== "pending") return { ok: false, value: this.ERR_INVALID_STATUS };
    if (counterCount >= this.MAX_COUNTER_OFFER_DEPTH) return { ok: false, value: this.ERR_COUNTER_OFFER_EXISTS };
    if (!this.validateItems(newOfferedItems)) return { ok: false, value: this.ERR_INVALID_ITEM };
    if (!this.validateItems(newRequestedItems)) return { ok: false, value: this.ERR_INVALID_ITEM };
    if (!(newExpiration > this.mockBlockHeight && newExpiration <= this.mockBlockHeight + 10080)) {
      return { ok: false, value: this.ERR_INVALID_EXPIRATION };
    }

    const newId = this.state.lastSwapId + 1;
    this.state.swaps.set(newId, {
      proposer: caller,
      proposedTo: original.proposer,
      offeredItems: newOfferedItems,
      requestedItems: newRequestedItems,
      status: "pending",
      expiration: newExpiration,
      timestamp: this.mockBlockHeight,
      parentSwapId: originalSwapId,
      childCounterId: null,
    });
    original.childCounterId = newId;
    original.status = "countered";
    this.state.swaps.set(originalSwapId, original);
    this.state.counterOfferCount.set(originalSwapId, { count: counterCount + 1 });
    this.appendToUserSwaps(caller, newId);
    this.appendToUserSwaps(original.proposer, newId);
    this.state.lastSwapId = newId;
    this.emitSwapEvent("countered", newId);
    return { ok: true, value: newId };
  }

  completeSwap(swapId: number, caller: string): ClarityResponse<boolean> {
    const swap = this.state.swaps.get(swapId);
    if (!swap) return { ok: false, value: this.ERR_SWAP_NOT_FOUND };
    if (caller !== this.state.contractOwner) return { ok: false, value: this.ERR_NOT_AUTHORIZED };
    if (swap.status !== "accepted") return { ok: false, value: this.ERR_INVALID_STATUS };

    swap.status = "completed";
    this.state.swaps.set(swapId, swap);
    this.emitSwapEvent("completed", swapId);
    return { ok: true, value: true };
  }

  getSwapDetails(swapId: number): ClarityResponse<SwapDetails | null> {
    return { ok: true, value: this.state.swaps.get(swapId) ?? null };
  }

  getUserSwaps(user: string): ClarityResponse<number[]> {
    return { ok: true, value: this.state.userSwaps.get(user)?.swapIds ?? [] };
  }

  findPotentialMatches(user: string, offeredItems: number[]): ClarityResponse<number[]> {
    // Simplified mock
    return { ok: true, value: [] };
  }

  getSwapChain(swapId: number): ClarityResponse<number[]> {
    // Simplified mock
    return { ok: true, value: [swapId] };
  }

  getLastSwapId(): ClarityResponse<number> {
    return { ok: true, value: this.state.lastSwapId };
  }
}

// Test setup
const accounts = {
  deployer: "deployer",
  user1: "wallet_1",
  user2: "wallet_2",
  user3: "wallet_3",
};

describe("SwapMatching Contract", () => {
  let contract: SwapMatchingMock;

  beforeEach(() => {
    contract = new SwapMatchingMock();
    contract.setMockBlockHeight(1000);
    vi.resetAllMocks();
  });

  it("should allow user to propose a swap", () => {
    const result = contract.proposeSwap(
      accounts.user2,
      [1, 2],
      [3],
      1100,
      accounts.user1
    );
    expect(result).toEqual({ ok: true, value: 1 });
    const details = contract.getSwapDetails(1);
    expect(details.value?.proposer).toBe(accounts.user1);
    expect(details.value?.status).toBe("pending");
  });

  it("should prevent self-swap", () => {
    const result = contract.proposeSwap(
      accounts.user1,
      [1],
      [2],
      1100,
      accounts.user1
    );
    expect(result).toEqual({ ok: false, value: 108 });
  });

  it("should allow proposed-to to accept swap", () => {
    contract.proposeSwap(accounts.user2, [1], [2], 1100, accounts.user1);
    const acceptResult = contract.acceptSwap(1, accounts.user2);
    expect(acceptResult).toEqual({ ok: true, value: true });
    const details = contract.getSwapDetails(1);
    expect(details.value?.status).toBe("accepted");
  });

  it("should prevent accept if expired", () => {
    contract.proposeSwap(accounts.user2, [1], [2], 1100, accounts.user1);
    contract.setMockBlockHeight(1200);
    const acceptResult = contract.acceptSwap(1, accounts.user2);
    expect(acceptResult).toEqual({ ok: false, value: 104 });
  });

  it("should allow proposer to cancel swap", () => {
    contract.proposeSwap(accounts.user2, [1], [2], 1100, accounts.user1);
    const cancelResult = contract.cancelSwap(1, accounts.user1);
    expect(cancelResult).toEqual({ ok: true, value: true });
    const details = contract.getSwapDetails(1);
    expect(details.value?.status).toBe("cancelled");
  });

  it("should allow counter-offer", () => {
    contract.proposeSwap(accounts.user2, [1], [2], 1100, accounts.user1);
    const counterResult = contract.counterOffer(1, [3], [4], 1150, accounts.user2);
    expect(counterResult).toEqual({ ok: true, value: 2 });
    const original = contract.getSwapDetails(1);
    expect(original.value?.status).toBe("countered");
    expect(original.value?.childCounterId).toBe(2);
    const counter = contract.getSwapDetails(2);
    expect(counter.value?.parentSwapId).toBe(1);
    expect(counter.value?.proposer).toBe(accounts.user2);
  });

  it("should allow owner to complete swap", () => {
    contract.proposeSwap(accounts.user2, [1], [2], 1100, accounts.user1);
    contract.acceptSwap(1, accounts.user2);
    const completeResult = contract.completeSwap(1, accounts.deployer);
    expect(completeResult).toEqual({ ok: true, value: true });
    const details = contract.getSwapDetails(1);
    expect(details.value?.status).toBe("completed");
  });

  it("should return user swaps", () => {
    contract.proposeSwap(accounts.user2, [1], [2], 1100, accounts.user1);
    const userSwaps = contract.getUserSwaps(accounts.user1);
    expect(userSwaps).toEqual({ ok: true, value: [1] });
  });

  it("should prevent invalid item lists", () => {
    const emptyResult = contract.proposeSwap(
      accounts.user2,
      [],
      [1],
      1100,
      accounts.user1
    );
    expect(emptyResult.ok).toBe(false);

    const tooMany = Array.from({ length: 6 }, (_, i) => i + 1);
    const maxResult = contract.proposeSwap(
      accounts.user2,
      tooMany,
      [1],
      1100,
      accounts.user1
    );
    expect(maxResult.ok).toBe(false);
  });
});