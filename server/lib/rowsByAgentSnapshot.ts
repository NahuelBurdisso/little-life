/**
 * A whole table (or a filtered slice of it) held in memory, grouped by agent,
 * and read again in ONE query only when the table's write counter has moved.
 *
 * Phases used to re-select an agent's rows per agent and per step — "the rows
 * might have changed since I last looked" — and most ticks nothing had. The
 * write counters in server/db/index.ts (TEMP triggers on this connection) say
 * exactly when something did, including writes made by simEvents listeners deep
 * inside another module, so a snapshot keyed on one answers from memory and
 * still sees every write the moment it lands.
 *
 * Rules for callers:
 * - Scope one instance to one phase call. The counters cannot see a ROLLBACK;
 *   a phase that throws discards its snapshot along with its transaction.
 * - Rows and arrays are shared: read them, never mutate them. Copy first if a
 *   row is going to be edited in place.
 * - `load` fixes the order within an agent. Match the order of the per-agent
 *   query being replaced (usually rowid: `ORDER BY id`).
 */
export class RowsByAgentSnapshot<Row> {
  private version = -1;
  private byAgent = new Map<number, Row[]>();
  private rows: Row[] = [];

  constructor(
    private readonly writeVersion: () => number,
    private readonly load: () => Row[],
    private readonly agentOf: (row: Row) => number,
  ) {}

  /** The agent's rows, in `load` order. */
  forAgent(agentId: number): readonly Row[] {
    this.refresh();
    return this.byAgent.get(agentId) ?? (EMPTY as readonly Row[]);
  }

  /** Every row, in `load` order. */
  all(): readonly Row[] {
    this.refresh();
    return this.rows;
  }

  private refresh(): void {
    const version = this.writeVersion();
    if (version === this.version) return;
    // Version first: a write landing between the two would then force another
    // read instead of being absorbed.
    this.version = version;
    this.rows = this.load();
    // A fresh map every time: a caller still iterating an array from the last
    // read (the states phase deletes rows while looping over them) keeps a
    // stable list.
    this.byAgent = new Map();
    for (const row of this.rows) {
      const id = this.agentOf(row);
      const list = this.byAgent.get(id);
      if (list) list.push(row);
      else this.byAgent.set(id, [row]);
    }
  }
}

const EMPTY: readonly never[] = Object.freeze([]);
