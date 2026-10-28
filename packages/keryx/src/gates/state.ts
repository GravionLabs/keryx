import type { BusEvent } from '../events/schema.js';
import { listEvents } from './bus-client.js';

export const GATE_FINISHED = 'gate.finished';
export const REVIEW_RECORDED = 'review.recorded';

export interface GateState {
  commit: string;
  /** Last `gate.finished` for the commit, or null. */
  gate: { eventId: number; at: string; passed: boolean; failedCommand: string | null } | null;
  /** Last `review.recorded` for the commit, or null. */
  review: { eventId: number; at: string; verdict: 'approve' | 'changes'; findings: number } | null;
}

function last(events: BusEvent[], type: string, commit: string): BusEvent | undefined {
  return events.findLast((e) => e.type === type && e.data.commit === commit);
}

/**
 * The gate state of one commit: its last gate result and last review verdict, read from the bus.
 * `open_pr` and `merge` (#20) decide on this.
 */
export async function readGateState(busUrl: string, commit: string): Promise<GateState> {
  const events = await listEvents(busUrl, [GATE_FINISHED, REVIEW_RECORDED]);
  const gate = last(events, GATE_FINISHED, commit);
  const review = last(events, REVIEW_RECORDED, commit);
  return {
    commit,
    gate: gate
      ? {
          eventId: gate.id,
          at: gate.at,
          passed: gate.data.passed === true,
          failedCommand:
            typeof gate.data.failedCommand === 'string' ? gate.data.failedCommand : null,
        }
      : null,
    review: review
      ? {
          eventId: review.id,
          at: review.at,
          verdict: review.data.verdict === 'approve' ? 'approve' : 'changes',
          findings: Array.isArray(review.data.findings) ? review.data.findings.length : 0,
        }
      : null,
  };
}
