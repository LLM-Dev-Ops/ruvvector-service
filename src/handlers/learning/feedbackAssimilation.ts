/**
 * Feedback Assimilation Agent Handler
 * Classification: FEEDBACK_ASSIMILATION
 * Purpose: Ingest structured human feedback and convert to normalized, machine-readable learning signals
 *
 * Capabilities (from PROMPT 0):
 * - MAY: Ingest reviewer feedback, normalize qualitative input into structured signals,
 *        emit feedback learning artifacts
 * - MUST NOT: Execute inference, modify documents, trigger orchestration, enforce governance
 *
 * Properties:
 * - Idempotent: Same inputs produce same outputs (via inputs_hash deduplication)
 * - Append-only: Only INSERT operations, never UPDATE or DELETE
 * - Emit exactly ONE LearningDecisionEvent per invocation
 * - CLI-invokable with 'assimilate' endpoint
 */
import { Request, Response } from 'express';
import { z } from 'zod';
import { v4 as uuidv4 } from 'uuid';
import { createHash } from 'crypto';
import { DatabaseClient } from '../../clients/DatabaseClient';
import {
  FeedbackAssimilationEvent,
  CreateFeedbackAssimilationResponse,
} from '../../types';
import logger from '../../utils/logger';
import { getOrCreateCorrelationId } from '../../utils/correlation';

// ============================================================================
// Type Definitions
// ============================================================================

export interface FeedbackSignal {
  dimension: string;       // e.g., "quality", "clarity", "accuracy", "completeness"
  value: number;          // -1.0 to +1.0
  confidence: number;     // 0.0 to 1.0
}

// ============================================================================
// Validation Schemas
// ============================================================================

/**
 * Zod schema for feedback assimilation request
 * Maps to CreateFeedbackAssimilationRequest from types
 */
export const createFeedbackAssimilationSchema = z.object({
  agent_id: z.string().default('feedback-assimilation-agent'),
  agent_version: z.string().default('1.0.0'),
  source_artifact_id: z.string().min(1),
  feedback_type: z.enum(['qualitative', 'quantitative', 'mixed']),
  raw_feedback: z.string().min(1),
  normalized_signals: z.array(z.object({
    dimension: z.string(),
    value: z.number().min(-1).max(1),
    confidence: z.number().min(0).max(1),
  })).optional(),
  assimilation_metadata: z.object({
    feedback_source: z.string(),
    processing_method: z.string(),
  }),
  outputs: z.object({}).optional(),
  confidence: z.number().min(0).max(1).optional(),
  constraints_applied: z.object({}).optional(),
  execution_ref: z.string().optional(),
  inputs_hash: z.string().optional(),
  timestamp: z.string().optional(),
});

// ============================================================================
// Core Logic Functions
// ============================================================================

/**
 * Compute SHA-256 hash of inputs for idempotency
 * Creates deterministic JSON representation sorted by keys
 */
export function computeInputsHash(inputs: object): string {
  // Create deterministic JSON by sorting keys recursively
  const sortedJson = JSON.stringify(inputs, Object.keys(inputs).sort());
  return createHash('sha256').update(sortedJson).digest('hex');
}

/**
 * Parse feedback dimensions from structured ratings and text analysis
 * Extracts dimensional scores: quality, clarity, accuracy, completeness
 */
export function parseFeedbackDimensions(
  rawFeedback: string,
  feedbackType: string,
  structuredRatings?: {
    quality?: number;
    clarity?: number;
    accuracy?: number;
    completeness?: number;
  }
): FeedbackSignal[] {
  const signals: FeedbackSignal[] = [];

  // Use structured ratings if provided
  if (structuredRatings) {
    if (structuredRatings.quality !== undefined) {
      signals.push({
        dimension: 'quality',
        value: structuredRatings.quality,
        confidence: 1.0, // High confidence for explicit ratings
      });
    }
    if (structuredRatings.clarity !== undefined) {
      signals.push({
        dimension: 'clarity',
        value: structuredRatings.clarity,
        confidence: 1.0,
      });
    }
    if (structuredRatings.accuracy !== undefined) {
      signals.push({
        dimension: 'accuracy',
        value: structuredRatings.accuracy,
        confidence: 1.0,
      });
    }
    if (structuredRatings.completeness !== undefined) {
      signals.push({
        dimension: 'completeness',
        value: structuredRatings.completeness,
        confidence: 1.0,
      });
    }
  }

  // If no structured ratings, derive from feedback type and text sentiment
  if (signals.length === 0) {
    const sentimentValue = deriveSentimentFromFeedbackType(feedbackType, rawFeedback);
    const confidence = 0.6; // Lower confidence for derived signals

    signals.push(
      { dimension: 'quality', value: sentimentValue, confidence },
      { dimension: 'clarity', value: sentimentValue, confidence },
      { dimension: 'accuracy', value: sentimentValue, confidence },
      { dimension: 'completeness', value: sentimentValue, confidence }
    );
  }

  return signals;
}

/**
 * Derive sentiment value from feedback type and text analysis
 * Simple heuristic-based sentiment extraction
 */
function deriveSentimentFromFeedbackType(feedbackType: string, rawFeedback: string): number {
  // Base sentiment from feedback type
  let sentiment = 0;
  switch (feedbackType) {
    case 'approval':
      sentiment = 0.8;
      break;
    case 'rejection':
      sentiment = -0.8;
      break;
    case 'suggestion':
      sentiment = 0.3;
      break;
    case 'critique':
      sentiment = -0.3;
      break;
    case 'rating':
      sentiment = 0;
      break;
  }

  // Adjust sentiment based on keyword analysis (simple heuristic)
  const lowerText = rawFeedback.toLowerCase();
  const positiveKeywords = ['excellent', 'great', 'good', 'clear', 'accurate', 'complete', 'well-done'];
  const negativeKeywords = ['poor', 'bad', 'unclear', 'inaccurate', 'incomplete', 'confusing', 'missing'];

  const positiveCount = positiveKeywords.filter(kw => lowerText.includes(kw)).length;
  const negativeCount = negativeKeywords.filter(kw => lowerText.includes(kw)).length;

  // Adjust sentiment by keyword balance
  const keywordAdjustment = (positiveCount - negativeCount) * 0.2;
  sentiment = Math.max(-1, Math.min(1, sentiment + keywordAdjustment));

  return sentiment;
}

/**
 * Normalize feedback into machine-readable structured signals
 */
export function normalizeFeedback(
  rawFeedback: string,
  feedbackType: string,
  structuredRatings?: object
): {
  normalized_signals: FeedbackSignal[];
  feedback_summary: string;
  processing_metadata: object;
} {
  // Parse dimensional signals
  const normalizedSignals = parseFeedbackDimensions(
    rawFeedback,
    feedbackType,
    structuredRatings as any
  );

  // Generate summary
  const avgValue = normalizedSignals.reduce((sum, s) => sum + s.value, 0) / normalizedSignals.length;
  const sentiment = avgValue > 0.3 ? 'positive' : avgValue < -0.3 ? 'negative' : 'neutral';
  const feedbackSummary = `${feedbackType} feedback with ${sentiment} sentiment (${normalizedSignals.length} dimensions)`;

  // Processing metadata
  const processingMetadata = {
    method: 'heuristic-sentiment-analysis',
    dimensions_extracted: normalizedSignals.length,
    had_structured_ratings: !!structuredRatings,
    feedback_length: rawFeedback.length,
    avg_signal_value: avgValue,
  };

  return {
    normalized_signals: normalizedSignals,
    feedback_summary: feedbackSummary,
    processing_metadata: processingMetadata,
  };
}

/**
 * Emit learning event to database (append-only)
 * Uses learning_events table for consistency with approvals handler
 * Returns the event ID
 */
export async function emitLearningEvent(
  event: FeedbackAssimilationEvent,
  dbClient: DatabaseClient
): Promise<string> {
  // Check for duplicate event via inputs_hash (idempotency)
  const existingResult = await dbClient.query(
    `SELECT id FROM learning_events
     WHERE inputs_hash = $1 AND decision_type = $2`,
    [event.inputs_hash, event.decision_type]
  );

  if (existingResult.rows.length > 0) {
    // Idempotent: Return existing event ID
    logger.info(
      { eventId: existingResult.rows[0].id, inputsHash: event.inputs_hash },
      'Duplicate feedback event detected, returning existing ID (idempotent)'
    );
    return existingResult.rows[0].id;
  }

  const eventId = uuidv4();

  // Append-only INSERT (never UPDATE or DELETE)
  // Map to learning_events table schema
  await dbClient.query(
    `INSERT INTO learning_events (
      id, agent_id, agent_version, decision_type, inputs_hash,
      outputs, confidence, constraints_applied,
      source_id, source_type, created_at
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
    [
      eventId,
      event.agent_id,
      event.agent_version,
      event.decision_type,
      event.inputs_hash,
      JSON.stringify(event.outputs),
      event.confidence,
      JSON.stringify(event.constraints_applied),
      event.source_artifact_id,
      'feedback_assimilation',
      new Date().toISOString(),
    ]
  );

  return eventId;
}

// ============================================================================
// HTTP Handler
// ============================================================================

/**
 * POST /learning/assimilate - Process feedback and emit learning signal
 * CLI-invokable endpoint for feedback ingestion
 */
export async function createFeedbackAssimilationHandler(
  req: Request,
  res: Response,
  dbClient: DatabaseClient
): Promise<void> {
  const correlationId = getOrCreateCorrelationId(req.headers);
  res.setHeader('x-correlation-id', correlationId);

  try {
    // Validate request body
    const validatedData = createFeedbackAssimilationSchema.parse(req.body);

    const {
      agent_id = 'feedback-assimilation-agent',
      agent_version = '1.0.0',
      source_artifact_id,
      feedback_type,
      raw_feedback,
      normalized_signals: providedSignals,
      assimilation_metadata,
      outputs: providedOutputs,
      confidence: providedConfidence,
      constraints_applied: providedConstraints,
      execution_ref,
      inputs_hash: providedHash,
      timestamp,
    } = validatedData;

    const eventTimestamp = timestamp || new Date().toISOString();

    // Normalize feedback into structured signals if not provided
    let normalizedSignals: FeedbackSignal[];
    let aggregateConfidence: number;
    let processingMethod: string;

    if (providedSignals && providedSignals.length > 0) {
      // Use provided signals
      normalizedSignals = providedSignals;
      aggregateConfidence = providedConfidence ||
        normalizedSignals.reduce((sum, s) => sum + s.confidence, 0) / normalizedSignals.length;
      processingMethod = assimilation_metadata.processing_method;
    } else {
      // Auto-normalize from raw feedback
      const normalized = normalizeFeedback(
        raw_feedback,
        feedback_type,
        undefined
      );
      normalizedSignals = normalized.normalized_signals;
      aggregateConfidence = normalizedSignals.reduce((sum, s) => sum + s.confidence, 0) / normalizedSignals.length;
      processingMethod = (normalized.processing_metadata as { method: string }).method;
    }

    // Prepare inputs for hash computation (deterministic)
    const inputs = {
      source_artifact_id,
      feedback_type,
      raw_feedback,
      feedback_source: assimilation_metadata.feedback_source,
    };

    const inputsHash = providedHash || computeInputsHash(inputs);

    // Create outputs object
    const outputs = providedOutputs || {
      normalized_signals: normalizedSignals,
      feedback_summary: `${feedback_type} feedback with ${normalizedSignals.length} dimensions`,
      processing_metadata: {
        method: processingMethod,
        dimensions_extracted: normalizedSignals.length,
        feedback_length: raw_feedback.length,
      },
    };

    // Create constraints_applied object
    const constraintsApplied = providedConstraints || {
      feedback_source: assimilation_metadata.feedback_source,
      processing_method: processingMethod,
    };

    // Create feedback assimilation event following PROMPT 0 spec
    const learningEvent: FeedbackAssimilationEvent = {
      agent_id,
      agent_version,
      decision_type: 'feedback_assimilation',
      source_artifact_id,
      feedback_type,
      raw_feedback,
      normalized_signals: normalizedSignals,
      assimilation_metadata,
      inputs_hash: inputsHash,
      outputs,
      confidence: aggregateConfidence,
      constraints_applied: constraintsApplied,
      execution_ref: execution_ref || `exec-${uuidv4()}`,
      timestamp: eventTimestamp,
    };

    // Emit event (append-only)
    const storedEventId = await emitLearningEvent(learningEvent, dbClient);

    logger.info(
      {
        correlationId,
        eventId: storedEventId,
        artifactId: source_artifact_id,
        feedbackType: feedback_type,
        signalsCount: normalizedSignals.length,
        confidence: aggregateConfidence,
      },
      'Feedback assimilated and learning event emitted'
    );

    // Build response following CreateFeedbackAssimilationResponse spec
    const response: CreateFeedbackAssimilationResponse = {
      id: storedEventId,
      agent_id,
      decision_type: 'feedback_assimilation',
      source_artifact_id,
      feedback_type,
      normalized_signals_count: normalizedSignals.length,
      created: true,
      timestamp: eventTimestamp,
    };

    res.status(201).json(response);
  } catch (error) {
    if (error instanceof z.ZodError) {
      logger.warn({ correlationId, errors: error.errors }, 'Feedback assimilation validation failed');
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

    logger.error({ correlationId, error }, 'Failed to assimilate feedback');
    res.status(500).json({
      error: 'internal_error',
      message: 'Failed to assimilate feedback',
      correlationId,
    });
  }
}

export default {
  createFeedbackAssimilationHandler,
  createFeedbackAssimilationSchema,
  computeInputsHash,
  normalizeFeedback,
  parseFeedbackDimensions,
  emitLearningEvent,
};
