/**
 * Decision Approval Handler with Learning Integration
 * Implements approval-based reinforcement learning for executive synthesis
 */
import { Request, Response } from 'express';
import { z } from 'zod';
import { v4 as uuidv4 } from 'uuid';
import { DatabaseClient } from '../clients/DatabaseClient';
import {
  DecisionRecord,
  CreateApprovalResponse,
} from '../types';
import logger from '../utils/logger';
import { getOrCreateCorrelationId } from '../utils/correlation';

// Learning rate for weight updates
const LEARNING_RATE = 0.1;

// Validation schema for approval event
export const createApprovalSchema = z.object({
  decision_id: z.string().min(1),           // Accept any string ID format
  approved: z.boolean(),
  confidence_adjustment: z.number().min(-1).max(1).optional(),
  timestamp: z.string().optional(),
});

/**
 * Extract recommendation type from recommendation string
 * e.g., "PROCEED: Ready to deploy" -> "PROCEED"
 */
function extractRecommendationType(recommendation: string): string {
  const match = recommendation.match(/^(PROCEED|DEFER|REJECT|REVIEW|HALT)/i);
  return match ? match[1].toUpperCase() : 'UNKNOWN';
}

/**
 * Apply reward to a learning weight edge
 * Uses exponential moving average for smooth updates
 */
async function updateLearningWeight(
  dbClient: DatabaseClient,
  sourceType: 'decision' | 'signal' | 'objective',
  sourceId: string,
  targetValue: string,
  reward: number
): Promise<void> {
  const id = uuidv4();
  const now = new Date().toISOString();

  // Upsert the learning weight with exponential moving average
  await dbClient.query(
    `INSERT INTO learning_weights (id, source_type, source_id, target_type, target_value, weight, update_count, created_at, updated_at)
     VALUES ($1, $2, $3, 'recommendation', $4, $5, 1, $6, $6)
     ON CONFLICT (source_type, source_id, target_type, target_value)
     DO UPDATE SET
       weight = learning_weights.weight + $7 * ($5 - learning_weights.weight),
       update_count = learning_weights.update_count + 1,
       updated_at = $6`,
    [id, sourceType, sourceId, targetValue, reward, now, LEARNING_RATE]
  );
}

/**
 * POST /decision/approval - Process approval event and apply learning
 */
export async function createApprovalHandler(
  req: Request,
  res: Response,
  dbClient: DatabaseClient
): Promise<void> {
  const correlationId = getOrCreateCorrelationId(req.headers);
  res.setHeader('x-correlation-id', correlationId);

  try {
    // Validate request body
    const validatedData = createApprovalSchema.parse(req.body);

    const {
      decision_id,
      approved,
      confidence_adjustment,
      timestamp,
    } = validatedData;

    // Load the associated decision record
    const decisionResult = await dbClient.query<DecisionRecord>(
      `SELECT id, objective, recommendation, confidence, signals, graph_relations
       FROM decisions WHERE id = $1`,
      [decision_id]
    );

    if (decisionResult.rows.length === 0) {
      res.status(404).json({
        error: 'not_found',
        message: `Decision with ID ${decision_id} not found`,
        correlationId,
      });
      return;
    }

    const decision = decisionResult.rows[0];

    // Derive reward signal: +1.0 for approval, -1.0 for rejection
    const reward = approved ? 1.0 : -1.0;

    // Apply confidence adjustment if provided
    const adjustedReward = confidence_adjustment
      ? reward * (1 + confidence_adjustment)
      : reward;

    // Create approval record
    const approvalId = uuidv4();
    const eventTimestamp = timestamp || new Date().toISOString();
    const now = new Date().toISOString();

    await dbClient.query(
      `INSERT INTO approvals (id, decision_id, approved, confidence_adjustment, reward, timestamp, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [approvalId, decision_id, approved, confidence_adjustment || null, adjustedReward, eventTimestamp, now]
    );

    // Extract recommendation type for edge updates
    const recommendationType = extractRecommendationType(decision.recommendation);

    // Track number of weight updates
    let weightsUpdated = 0;

    // 1. Update decision → recommendation edge weight
    await updateLearningWeight(
      dbClient,
      'decision',
      decision_id,
      recommendationType,
      adjustedReward
    );
    weightsUpdated++;

    // 2. Update signal → recommendation edges
    const signals = decision.signals as { financial: string; risk: string; complexity: string };
    for (const [signalType, signalValue] of Object.entries(signals)) {
      // Create a composite signal ID from type and summary hash
      const signalId = `${signalType}:${signalValue.substring(0, 50)}`;
      await updateLearningWeight(
        dbClient,
        'signal',
        signalId,
        recommendationType,
        adjustedReward
      );
      weightsUpdated++;
    }

    // 3. Update objective → recommendation trajectory
    // Use objective text (truncated) as identifier
    const objectiveId = decision.objective.substring(0, 200);
    await updateLearningWeight(
      dbClient,
      'objective',
      objectiveId,
      recommendationType,
      adjustedReward
    );
    weightsUpdated++;

    // 4. SONA Integration: Record learning trajectory
    // Store trajectory metadata for future pattern reinforcement
    const trajectoryId = uuidv4();
    await dbClient.query(
      `INSERT INTO learning_weights (id, source_type, source_id, target_type, target_value, weight, update_count, created_at, updated_at)
       VALUES ($1, 'decision', $2, 'recommendation', $3, $4, 1, $5, $5)
       ON CONFLICT (source_type, source_id, target_type, target_value)
       DO UPDATE SET
         weight = learning_weights.weight + $6 * ($4 - learning_weights.weight),
         update_count = learning_weights.update_count + 1,
         updated_at = $5`,
      [trajectoryId, `trajectory:${decision_id}`, `pattern:${recommendationType}`, adjustedReward, now, LEARNING_RATE]
    );
    weightsUpdated++;

    logger.info(
      {
        correlationId,
        approvalId,
        decisionId: decision_id,
        approved,
        reward: adjustedReward,
        recommendationType,
        weightsUpdated,
      },
      'Approval processed and learning applied'
    );

    const response: CreateApprovalResponse = {
      id: approvalId,
      decision_id,
      reward: adjustedReward,
      weights_updated: weightsUpdated,
      learning_applied: true,
    };

    res.status(201).json(response);
  } catch (error) {
    if (error instanceof z.ZodError) {
      logger.warn({ correlationId, errors: error.errors }, 'Approval validation failed');
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

    logger.error({ correlationId, error }, 'Failed to process approval');
    res.status(500).json({
      error: 'internal_error',
      message: 'Failed to process approval',
      correlationId,
    });
  }
}

export default {
  createApprovalHandler,
  createApprovalSchema,
};
