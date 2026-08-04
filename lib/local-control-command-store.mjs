const ALLOWED_COMMANDS = new Set([
  'status',
  'open',
  'start',
  'pause',
  'resume',
  'reconcile',
  'stop'
]);

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

export function createLocalControlCommandStore({
  now = Date.now,
  createId = () => crypto.randomUUID(),
  leaseMs = 60000,
  retentionMs = 10 * 60 * 1000,
  maxCommands = 200
} = {}) {
  const commands = new Map();

  function cleanup() {
    const cutoff = now() - retentionMs;
    for (const [id, record] of commands) {
      if (
        Number(record.completedAt || record.createdAt) < cutoff ||
        commands.size > maxCommands
      ) {
        commands.delete(id);
      }
    }
  }

  function enqueue(command, payload = {}) {
    cleanup();
    if (!ALLOWED_COMMANDS.has(command)) {
      const error = new Error('local_control_command_forbidden');
      error.code = 'local_control_command_forbidden';
      throw error;
    }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      const error = new Error('local_control_payload_invalid');
      error.code = 'local_control_payload_invalid';
      throw error;
    }
    const id = createId();
    const record = {
      id,
      command,
      payload: clone(payload),
      state: 'pending',
      createdAt: now(),
      claimedAt: null,
      completedAt: null,
      result: null
    };
    commands.set(id, record);
    return clone(record);
  }

  function claimNext() {
    cleanup();
    const timestamp = now();
    const record = [...commands.values()].find((candidate) => (
      candidate.state === 'pending' ||
      (
        candidate.state === 'claimed' &&
        timestamp - candidate.claimedAt >= leaseMs
      )
    ));
    if (!record) return null;
    record.state = 'claimed';
    record.claimedAt = timestamp;
    return {
      id: record.id,
      command: record.command,
      payload: clone(record.payload),
      createdAt: record.createdAt
    };
  }

  function complete(id, result) {
    const record = commands.get(id);
    if (!record) {
      const error = new Error('local_control_command_not_found');
      error.code = 'local_control_command_not_found';
      throw error;
    }
    if (record.state === 'completed') return clone(record);
    record.state = 'completed';
    record.completedAt = now();
    record.result = clone(result);
    return clone(record);
  }

  function get(id) {
    cleanup();
    return clone(commands.get(id) || null);
  }

  return {
    enqueue,
    claimNext,
    complete,
    get
  };
}
