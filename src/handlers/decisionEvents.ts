/**
 * Decision Events API Handler
 * Exposes DecisionEvent consumption API for downstream execution engines
 *
 * Endpoint: GET /events/decisions
 * Purpose: Allow execution engines to poll for approved plans and execution-relevant events
 */
import { Request, Response } from 'express';
import { DatabaseClient } from '../clients/DatabaseClient';
import logger from '../utils/logger';
import { getOrCreateCorrelationId } from '../utils/correlation';

/**
 * Supported decision event types
 */
export type DecisionEventType =
  | 'plan_created'
  | 'plan_approved'
  | 'plan_rejected'
  | 'plan_deferred';

/**
 * Decision event payload structure
 */
export interface DecisionEventPayload {
  plan_id?: string;
  simulation_id?: string;
  decision_id?: string;
  objective?: string;
  recommendation?: string;
  confidence?: string;
  reward?: number;
  reviewer_outcome?: string;
  [key: string]: unknown;
}

/**
 * Decision event response structure
 */
export interface DecisionEvent {
  id: string;
  type: DecisionEventType;
  timestamp: string;
  payload: DecisionEventPayload;
}

/**
 * Response structure for GET /events/decisions
 */
export interface DecisionEventsResponse {
  events: DecisionEvent[];
  next_cursor: string | null;
}

/**
 * Default pagination limit
 */
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 1000;

/**
 * Parse comma-separated event types filter
 */
function parseEventTypes(typesParam: string | undefined): DecisionEventType[] | null {
  if (!typesParam || typeof typesParam !== 'string') {
    return null;
  }

  const validTypes: DecisionEventType[] = ['plan_created', 'plan_approved', 'plan_rejected', 'plan_deferred'];
  const requestedTypes = typesParam.split(',').map(t => t.trim().toLowerCase());
  const filteredTypes = requestedTypes.filter(t => validTypes.includes(t as DecisionEventType)) as DecisionEventType[];

  return filteredTypes.length > 0 ? filteredTypes : null;
}

/**
 * Map approval outcome to event type
 */
function mapApprovalToEventType(approved: boolean): DecisionEventType {
  return approved ? 'plan_approved' : 'plan_rejected';
}

/**
 * GET /events/decisions - Fetch decision events for downstream execution engines
 *
 * Query Parameters:
 * - types: comma-separated event types (optional)
 * - after: cursor - last seen event ID (optional)
 * - limit: number of events to return (optional, default 100, max 1000)
 *
 * Response:
 * {
 *   "events": [...],
 *   "next_cursor": "<event_id | null>"
 * }
 */
export async function listDecisionEventsHandler(
  req: Request,
  res: Response,
  dbClient: DatabaseClient
): Promise<void> {
  const correlationId = getOrCreateCorrelationId(req.headers);
  res.setHeader('x-correlation-id', correlationId);

  try {
    const { types, after, limit } = req.query;

    // Parse and validate limit
    const parsedLimit = Math.min(
      Math.max(parseInt(limit as string, 10) || DEFAULT_LIMIT, 1),
      MAX_LIMIT
    );

    // Parse event types filter
    const eventTypes = parseEventTypes(types as string);

    // Build unified query to fetch events from both decisions and approvals tables
    // Events are ordered by created_at ASC for stable polling
    const events: DecisionEvent[] = [];

    // Determine which event types to query
    const includeCreated = !eventTypes || eventTypes.includes('plan_created');
    const includeApproved = !eventTypes || eventTypes.includes('plan_approved');
    const includeRejected = !eventTypes || eventTypes.includes('plan_rejected');
    const includeDeferred = !eventTypes || eventTypes.includes('plan_deferred');

    // Query for plan_created events from decisions table
    if (includeCreated) {
      let decisionsQuery = `
        SELECT
          id,
          'plan_created' as event_type,
          created_at as timestamp,
          objective,
          recommendation,
          confidence,
          command,
          raw_output_hash
        FROM decisions
      `;
      const decisionsParams: unknown[] = [];
      let paramIndex = 1;

      // Apply cursor filter if provided (cursor is composite: type:id:timestamp)
      if (after && typeof after === 'string') {
        const cursorParts = parseCursor(after);
        if (cursorParts) {
          decisionsQuery += ` WHERE (created_at, id) > ($${paramIndex}, $${paramIndex + 1})`;
          decisionsParams.push(cursorParts.timestamp, cursorParts.id);
          paramIndex += 2;
        }
      }

      decisionsQuery += ` ORDER BY created_at ASC, id ASC LIMIT $${paramIndex}`;
      decisionsParams.push(parsedLimit);

      const decisionsResult = await dbClient.query<{
        id: string;
        event_type: string;
        timestamp: Date;
        objective: string;
        recommendation: string;
        confidence: string;
        command: string;
        raw_output_hash: string;
      }>(decisionsQuery, decisionsParams);

      for (const row of decisionsResult.rows) {
        events.push({
          id: buildEventId('plan_created', row.id, row.timestamp),
          type: 'plan_created',
          timestamp: new Date(row.timestamp).toISOString(),
          payload: {
            plan_id: row.id,
            decision_id: row.id,
            objective: row.objective,
            recommendation: row.recommendation,
            confidence: row.confidence,
            command: row.command,
            checksum: row.raw_output_hash,
          },
        });
      }
    }

    // Query for plan_approved/plan_rejected events from approvals table
    if (includeApproved || includeRejected || includeDeferred) {
      let approvalsQuery = `
        SELECT
          a.id,
          a.decision_id,
          a.approved,
          a.reward,
          a.confidence_adjustment,
          a.created_at as timestamp,
          d.objective,
          d.recommendation
        FROM approvals a
        JOIN decisions d ON d.id = a.decision_id
      `;
      const approvalsParams: unknown[] = [];
      let paramIndex = 1;
      const conditions: string[] = [];

      // Filter by approval status based on requested event types
      const approvalFilters: string[] = [];
      if (includeApproved) approvalFilters.push('a.approved = true');
      if (includeRejected) approvalFilters.push('a.approved = false');

      if (approvalFilters.length > 0 && approvalFilters.length < 2) {
        conditions.push(`(${approvalFilters.join(' OR ')})`);
      }

      // Apply cursor filter if provided
      if (after && typeof after === 'string') {
        const cursorParts = parseCursor(after);
        if (cursorParts) {
          conditions.push(`(a.created_at, a.id::text) > ($${paramIndex}, $${paramIndex + 1})`);
          approvalsParams.push(cursorParts.timestamp, cursorParts.id);
          paramIndex += 2;
        }
      }

      if (conditions.length > 0) {
        approvalsQuery += ` WHERE ${conditions.join(' AND ')}`;
      }

      approvalsQuery += ` ORDER BY a.created_at ASC, a.id ASC LIMIT $${paramIndex}`;
      approvalsParams.push(parsedLimit);

      const approvalsResult = await dbClient.query<{
        id: string;
        decision_id: string;
        approved: boolean;
        reward: number;
        confidence_adjustment: number | null;
        timestamp: Date;
        objective: string;
        recommendation: string;
      }>(approvalsQuery, approvalsParams);

      for (const row of approvalsResult.rows) {
        const eventType = mapApprovalToEventType(row.approved);
        events.push({
          id: buildEventId(eventType, row.id, row.timestamp),
          type: eventType,
          timestamp: new Date(row.timestamp).toISOString(),
          payload: {
            plan_id: row.decision_id,
            decision_id: row.decision_id,
            simulation_id: row.decision_id, // Alias for execution engine compatibility
            objective: row.objective,
            recommendation: row.recommendation,
            reward: row.reward,
            confidence_adjustment: row.confidence_adjustment,
            reviewer_outcome: row.approved ? 'approved' : 'rejected',
          },
        });
      }
    }

    // Sort all events by timestamp (ascending) for stable ordering
    events.sort((a, b) => {
      const timeA = new Date(a.timestamp).getTime();
      const timeB = new Date(b.timestamp).getTime();
      if (timeA !== timeB) return timeA - timeB;
      return a.id.localeCompare(b.id);
    });

    // Trim to requested limit (we may have fetched more from combined queries)
    const trimmedEvents = events.slice(0, parsedLimit);

    // Compute next_cursor from the last event
    const nextCursor = trimmedEvents.length > 0
      ? trimmedEvents[trimmedEvents.length - 1].id
      : null;

    logger.info(
      {
        correlationId,
        eventCount: trimmedEvents.length,
        types: eventTypes,
        after,
        limit: parsedLimit,
        nextCursor,
      },
      'Decision events retrieved successfully'
    );

    const response: DecisionEventsResponse = {
      events: trimmedEvents,
      next_cursor: nextCursor,
    };

    res.status(200).json(response);
  } catch (error) {
    logger.error({ correlationId, error }, 'Failed to retrieve decision events');
    res.status(500).json({
      error: 'internal_error',
      message: 'Failed to retrieve decision events',
      correlationId,
    });
  }
}

/**
 * Build a composite event ID for cursor-based pagination
 * Format: <type>:<id>:<timestamp_unix_ms>
 */
function buildEventId(type: string, id: string, timestamp: Date | string): string {
  const ts = typeof timestamp === 'string' ? new Date(timestamp) : timestamp;
  return `${type}:${id}:${ts.getTime()}`;
}

/**
 * Parse cursor string back into components
 */
function parseCursor(cursor: string): { type: string; id: string; timestamp: Date } | null {
  try {
    const parts = cursor.split(':');
    if (parts.length < 3) return null;

    const type = parts[0];
    const timestampMs = parseInt(parts[parts.length - 1], 10);
    // ID may contain colons, so join everything between type and timestamp
    const id = parts.slice(1, -1).join(':');

    if (isNaN(timestampMs)) return null;

    return {
      type,
      id,
      timestamp: new Date(timestampMs),
    };
  } catch {
    return null;
  }
}

export default {
  listDecisionEventsHandler,
};
