import { afterEach, describe, expect, it } from 'bun:test';
import { createMigrationController } from '../src/index.js';

describe('migration controller wiring gate', () => {
  const original = process.env.LLAMACTL_FLEET_MOVE_ENABLED;

  afterEach(() => {
    if (original === undefined) {
      delete process.env.LLAMACTL_FLEET_MOVE_ENABLED;
      return;
    }
    process.env.LLAMACTL_FLEET_MOVE_ENABLED = original;
  });

  it('wires controller even when LLAMACTL_FLEET_MOVE_ENABLED is absent', () => {
    delete process.env.LLAMACTL_FLEET_MOVE_ENABLED;

    const controller = createMigrationController({
      peers: [],
      fetchSnapshot: async () => ({ pressureState: 'NORMAL', node_mem: { free_mb: 4096 }, workloads: [] }),
      applyWorkload: async () => undefined,
      deleteWorkload: async () => undefined,
      leaseholder: 'm4pro',
    });

    expect(controller).not.toBeNull();
  });
});
