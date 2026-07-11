// NS1 Activity-API event source. Polls GET /v1/account/activity via the existing read-only
// client and normalises it. This is the only NS1-specific piece; the service consumes the
// generic ActivityBatch, so a webhook source can replace this later.
import type { Ns1ReadClient } from '../ns1/client.js';
import { normaliseActivity } from '../ns1/activity.js';
import type { ActivityBatch, ChangeEventSource } from './types.js';

export class Ns1ActivityEventSource implements ChangeEventSource {
  readonly name = 'ns1-activity-poll';

  constructor(
    private readonly client: Ns1ReadClient,
    private readonly limit = 100,
  ) {}

  async poll(correlationId?: string): Promise<ActivityBatch> {
    const raw = await this.client.getActivity({ limit: this.limit }, correlationId);
    return { entries: normaliseActivity(raw) };
  }
}
