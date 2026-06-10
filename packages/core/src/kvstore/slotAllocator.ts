export class SlotAllocator {
  private readonly maxSlots: number;
  private singleSlotBusy = false;
  private readonly busySlots = new Set<number>();

  constructor(maxSlots = 1) {
    if (!Number.isInteger(maxSlots) || maxSlots < 1) {
      throw new Error(`SlotAllocator maxSlots must be >= 1, got ${String(maxSlots)}`);
    }
    this.maxSlots = maxSlots;
  }

  acquire(): { slotId: number; release: () => void } | null {
    if (this.maxSlots === 1) return this.acquireSingleSlot();
    return this.acquireMultiSlot();
  }

  inUse(): number[] {
    if (this.maxSlots === 1) return this.singleSlotBusy ? [0] : [];
    return [...this.busySlots].sort((a, b) => a - b);
  }

  private acquireSingleSlot(): { slotId: number; release: () => void } | null {
    if (this.singleSlotBusy) return null;
    this.singleSlotBusy = true;
    let released = false;
    return {
      slotId: 0,
      release: (): void => {
        if (released) return;
        released = true;
        this.singleSlotBusy = false;
      },
    };
  }

  private acquireMultiSlot(): { slotId: number; release: () => void } | null {
    let selectedSlot: number | null = null;
    for (let slotId = 0; slotId < this.maxSlots; slotId += 1) {
      if (this.busySlots.has(slotId)) continue;
      selectedSlot = slotId;
      break;
    }
    if (selectedSlot === null) return null;
    this.busySlots.add(selectedSlot);
    let released = false;
    return {
      slotId: selectedSlot,
      release: (): void => {
        if (released) return;
        released = true;
        this.busySlots.delete(selectedSlot);
      },
    };
  }
}
