/**
 * Approval Learning Agent Handler
 *
 * Classification: APPROVAL_LEARNING
 * Purpose: Capture and normalize human approval/rejection outcomes into structured learning signals
 * Decision Type: approval_learning
 *
 * Requirements from PROMPT 0:
 * - Agents MAY: Ingest approval/rejection outcomes, normalize reviewer outcomes, emit approval learning signals
 * - Agents MUST NOT: Execute inference, modify documents, trigger orchestration, enforce governance
 * - Must be idempotent, append-only writes only
 * - Must emit exactly ONE learning DecisionEvent per invocation
 * - Must be CLI-invokable with 'learn' endpoint
 */

import { Request, Response } from 'express';
import { z } from 'zod';
import { v4 as uuidv4 } from 'uuid';
import { createHash } from 'crypto';
import { DatabaseClient } from '../../clients/DatabaseClient';
import { DecisionRecord } from '../../types';
import logger from '../../utils/logger';
import { getOrCreateCorrelationId } from '../../utils/correlation';

/**
 * Learning Decision Event structure
 * Represents a single learning signal emitted by the approval learning agent
 */
interface LearningDecisionEvent {
  id: string;
  agent_id: string;
  agent_version: string;
  decision_type: string;
  source_decision_id?: string;
  inputs: Record<string, unknown>;
  inputs_hash: string;
  output: Record<string, unknown>;
  confidence: number;
  constraints_applied: Record<string, unknown>;
  created_at: string;
}

/**
 * Validation schema for approval learning input
 * Accepts approval/rejection outcomes with optional context
 */
export const createApprovalLearningSchema = z.object({
  decision_id: z.string().min(1).optional(), // Source decision being learned from
  approved: z.boolean(), // Binary approval/rejection signal
  confidence_adjustment: z.number().min(-1).max(1).optional(), // Fine-tune signal strength
  reviewer_role: z.string().optional(), // Context: who approved/rejected
  review_scope: z.string().optional(), // Context: what aspect was reviewed
  artifact_type: z.string().optional(), // Context: type of artifact reviewed
  feedback: z.string().optional(), // Optional human feedback text
  timestamp: z.string().optional(), // Event timestamp
});

export type ApprovalLearningInput = z.infer<typeof createApprovalLearningSchema>;

/**
 * Normalize approval signal to -1 to +1 range
 *
 * @param approved - Binary approval/rejection
 * @param confidence_adjustment - Optional adjustment factor (-1 to +1)
 * @returns Normalized signal in range [-1, +1]
 */
export function normalizeApprovalSignal(
  approved: boolean,
  confidence_adjustment?: number
): number {
  // Base signal: +1 for approval, -1 for rejection
  const baseSignal = approved ? 1.0 : -1.0;

  // Apply confidence adjustment if provided
  if (confidence_adjustment !== undefined) {
    // Adjustment modulates signal strength: 0 = no change, +1 = amplify, -1 = dampen
    const adjustmentFactor = 1.0 + confidence_adjustment;
    return Math.max(-1, Math.min(1, baseSignal * adjustmentFactor));
  }

  return baseSignal;
}

/**
 * Compute deterministic SHA-256 hash of inputs
 * Ensures idempotency by identifying duplicate learning signals
 *
 * @param inputs - Input data to hash
 * @returns SHA-256 hex digest
 */
export function computeInputsHash(inputs: Record<string, unknown>): string {
  // Sort keys for deterministic JSON serialization
  const sortedKeys = Object.keys(inputs).sort();
  const deterministicJson = JSON.stringify(
    sortedKeys.reduce((acc, key) => {
      acc[key] = inputs[key];
      return acc;
    }, {} as Record<string, unknown>)
  );

  return createHash('sha256').update(deterministicJson).digest('hex');
}

/**
 * Emit learning decision event via append-only INSERT
 * Never performs UPDATE or DELETE operations
 *
 * @param event - Learning decision event to emit
 * @param dbClient - Database client for append-only writes
 */
async function emitLearningDecisionEvent(
  event: LearningDecisionEvent,
  dbClient: DatabaseClient
): Promise<void> {
  // Append-only INSERT with ON CONFLICT DO NOTHING for idempotency
  await dbClient.query(
    `INSERT INTO learning_events (
      id, agent_id, agent_version, decision_type, source_id,
      outputs, inputs_hash, confidence, constraints_applied, source_type, created_at
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
    ON CONFLICT (inputs_hash) DO NOTHING`,
    [
      event.id,
      event.agent_id,
      event.agent_version,
      event.decision_type,
      event.source_decision_id || null,
      JSON.stringify(event.output),
      event.inputs_hash,
      event.confidence,
      JSON.stringify(event.constraints_applied),
      'approval_learning',
      event.created_at,
    ]
  );
}

/**
 * POST /learn/approval - Approval Learning Agent endpoint
 *
 * Ingests approval/rejection outcomes and emits structured learning signals
 * Idempotent, append-only, deterministic
 */
export async function createApprovalLearningHandler(
  req: Request,
  res: Response,
  dbClient: DatabaseClient
): Promise<void> {
  const correlationId = getOrCreateCorrelationId(req.headers);
  res.setHeader('x-correlation-id', correlationId);

  try {
    // Validate request body
    const validatedData = createApprovalLearningSchema.parse(req.body);

    const {
      decision_id,
      approved,
      confidence_adjustment,
      reviewer_role,
      review_scope,
      artifact_type,
      feedback,
      timestamp,
    } = validatedData;

    // Load source decision if provided
    let sourceDecision: DecisionRecord | null = null;
    if (decision_id) {
      const decisionResult = await dbClient.query<DecisionRecord>(
        `SELECT id, objective, recommendation, confidence, signals, graph_relations, created_at
         FROM decisions WHERE id = $1`,
        [decision_id]
      );

      if (decisionResult.rows.length > 0) {
        sourceDecision = decisionResult.rows[0];
      } else {
        logger.warn(
          { correlationId, decision_id },
          'Source decision not found - proceeding without context'
        );
      }
    }

    // Normalize approval signal to -1 to +1
    const normalizedSignal = normalizeApprovalSignal(approved, confidence_adjustment);

    // Build inputs for deterministic hashing
    const inputs: Record<string, unknown> = {
      decision_id: decision_id || 'none',
      approved,
      confidence_adjustment: confidence_adjustment || 0,
      reviewer_role: reviewer_role || 'unknown',
      review_scope: review_scope || 'general',
      artifact_type: artifact_type || 'unknown',
      timestamp: timestamp || new Date().toISOString(),
    };

    // Compute deterministic inputs hash for idempotency
    const inputsHash = computeInputsHash(inputs);

    // Generate UUID for event ID (idempotency handled by inputs_hash unique constraint)
    const eventId = uuidv4();

    // Build output with normalized signal
    const output = {
      normalized_signal: normalizedSignal,
      signal_type: approved ? 'approval' : 'rejection',
      signal_strength: Math.abs(normalizedSignal),
      feedback: feedback || null,
      source_recommendation: sourceDecision?.recommendation || null,
      source_confidence: sourceDecision?.confidence || null,
    };

    // Compute confidence based on signal strength and context availability
    let confidence = Math.abs(normalizedSignal);
    if (sourceDecision) {
      confidence = Math.min(1.0, confidence + 0.1); // Boost confidence if source context available
    }
    if (reviewer_role && reviewer_role !== 'unknown') {
      confidence = Math.min(1.0, confidence + 0.05); // Boost confidence if reviewer role known
    }

    // Build constraints applied metadata
    const constraintsApplied = {
      reviewer_role: reviewer_role || 'unknown',
      review_scope: review_scope || 'general',
      artifact_type: artifact_type || 'unknown',
      has_source_context: !!sourceDecision,
      has_feedback: !!feedback,
    };

    // Create learning decision event
    const learningEvent: LearningDecisionEvent = {
      id: eventId,
      agent_id: 'approval-learning-agent',
      agent_version: '1.0.0',
      decision_type: 'approval_learning',
      source_decision_id: decision_id,
      inputs,
      inputs_hash: inputsHash,
      output,
      confidence,
      constraints_applied: constraintsApplied,
      created_at: timestamp || new Date().toISOString(),
    };

    // Emit event via append-only INSERT
    await emitLearningDecisionEvent(learningEvent, dbClient);

    logger.info(
      {
        correlationId,
        eventId,
        decision_id,
        approved,
        normalizedSignal,
        confidence,
        inputsHash,
      },
      'Approval learning signal emitted'
    );

    // Return deterministic, machine-readable output
    res.status(201).json({
      id: eventId,
      decision_type: 'approval_learning',
      normalized_signal: normalizedSignal,
      confidence,
      inputs_hash: inputsHash,
      idempotent: true,
      learning_applied: true,
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      logger.warn({ correlationId, errors: error.errors }, 'Approval learning validation failed');
      res.status(400).json({
        error: 'validation_error',
        message: 'Request validation failed',
        correlationId,
        details: error.errors.map(e => ({
          path: e.path.join('.'),
          message: e.message,
        })),
      });
      return;
    }

    logger.error({ correlationId, error }, 'Failed to process approval learning');
    res.status(500).json({
      error: 'internal_error',
      message: 'Failed to process approval learning',
      correlationId,
    });
  }
}

export default {
  createApprovalLearningHandler,
  createApprovalLearningSchema,
  normalizeApprovalSignal,
  computeInputsHash,
};
