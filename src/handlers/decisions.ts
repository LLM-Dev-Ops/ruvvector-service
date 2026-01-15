/**
 * Decisions API Handlers for Executive Synthesis
 * Implements CRUD operations for Decision Records storage in PostgreSQL
 */
import { Request, Response } from 'express';
import { z } from 'zod';
import { DatabaseClient } from '../clients/DatabaseClient';
import {
  DecisionRecord,
  CreateDecisionResponse,
  ListDecisionsResponse,
} from '../types';
import logger from '../utils/logger';
import { getOrCreateCorrelationId } from '../utils/correlation';

// Validation schema for signals
const signalsSchema = z.object({
  financial: z.string(),
  risk: z.string(),
  complexity: z.string(),
});

// Validation schema for graph relations
const graphRelationsSchema = z.object({
  objective_to_repos: z.array(z.string()),
  repos_to_signals: z.record(z.array(z.string())),
  signals_to_recommendation: z.array(z.string()),
});

// Validation schema for creating a decision
export const createDecisionSchema = z.object({
  id: z.string().min(1),                    // Accept any string ID (e.g., "decision-uuid")
  objective: z.string().min(1),
  command: z.string().min(1),
  raw_output_hash: z.string().min(1),       // Accept any hash format
  recommendation: z.string().min(1),
  confidence: z.string().min(1),            // Accept freeform confidence (e.g., "LOW - Insufficient data")
  signals: signalsSchema,
  embedding_text: z.string().min(1),
  graph_relations: graphRelationsSchema,
  created_at: z.string().optional(),
});

/**
 * POST /v1/decisions - Store a new decision record
 */
export async function createDecisionHandler(
  req: Request,
  res: Response,
  dbClient: DatabaseClient
): Promise<void> {
  const correlationId = getOrCreateCorrelationId(req.headers);
  res.setHeader('x-correlation-id', correlationId);

  try {
    // Validate request body
    const validatedData = createDecisionSchema.parse(req.body);

    const {
      id,
      objective,
      command,
      raw_output_hash,
      recommendation,
      confidence,
      signals,
      embedding_text,
      graph_relations,
      created_at,
    } = validatedData;

    // Use provided timestamp or default to now
    const createdAt = created_at || new Date().toISOString();

    // Insert decision into database
    // Note: embedding field left null - actual embedding generation is a future enhancement
    await dbClient.query(
      `INSERT INTO decisions (id, objective, command, raw_output_hash, recommendation, confidence, signals, embedding_text, embedding, graph_relations, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       ON CONFLICT (id) DO UPDATE SET
         objective = EXCLUDED.objective,
         command = EXCLUDED.command,
         raw_output_hash = EXCLUDED.raw_output_hash,
         recommendation = EXCLUDED.recommendation,
         confidence = EXCLUDED.confidence,
         signals = EXCLUDED.signals,
         embedding_text = EXCLUDED.embedding_text,
         graph_relations = EXCLUDED.graph_relations`,
      [
        id,
        objective,
        command,
        raw_output_hash,
        recommendation,
        confidence,
        JSON.stringify(signals),
        embedding_text,
        null, // embedding - placeholder for future vector embedding
        JSON.stringify(graph_relations),
        createdAt,
      ]
    );

    logger.info(
      { correlationId, decisionId: id, confidence, recommendation: recommendation.substring(0, 50) },
      'Decision stored successfully'
    );

    // Build the stored decision for response
    const storedDecision: DecisionRecord = {
      id,
      objective,
      command,
      raw_output_hash,
      recommendation,
      confidence,
      signals,
      embedding_text,
      embedding: null,
      graph_relations,
      created_at: createdAt,
    };

    const response: CreateDecisionResponse = {
      id,
      created: true,
      decision: storedDecision,
    };

    res.status(201).json(response);
  } catch (error) {
    if (error instanceof z.ZodError) {
      logger.warn({ correlationId, errors: error.errors }, 'Decision validation failed');
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

    logger.error({ correlationId, error }, 'Failed to store decision');
    res.status(500).json({
      error: 'internal_error',
      message: 'Failed to store decision',
      correlationId,
    });
  }
}

/**
 * GET /v1/decisions/:id - Retrieve a decision by ID
 */
export async function getDecisionHandler(
  req: Request,
  res: Response,
  dbClient: DatabaseClient
): Promise<void> {
  const correlationId = getOrCreateCorrelationId(req.headers);
  res.setHeader('x-correlation-id', correlationId);

  try {
    const { id } = req.params;

    // Validate ID is not empty
    if (!id || id.trim().length === 0) {
      res.status(400).json({
        error: 'validation_error',
        message: 'Decision ID is required',
        correlationId,
      });
      return;
    }

    const result = await dbClient.query<DecisionRecord>(
      `SELECT id, objective, command, raw_output_hash, recommendation, confidence, signals, embedding_text, embedding, graph_relations, created_at
       FROM decisions WHERE id = $1`,
      [id]
    );

    if (result.rows.length === 0) {
      res.status(404).json({
        error: 'not_found',
        message: `Decision with ID ${id} not found`,
        correlationId,
      });
      return;
    }

    const row = result.rows[0];

    // Format response
    const decision: DecisionRecord = {
      id: row.id,
      objective: row.objective,
      command: row.command,
      raw_output_hash: row.raw_output_hash,
      recommendation: row.recommendation,
      confidence: row.confidence,
      signals: row.signals,
      embedding_text: row.embedding_text,
      embedding: row.embedding,
      graph_relations: row.graph_relations,
      created_at: new Date(row.created_at).toISOString(),
    };

    logger.info({ correlationId, decisionId: id }, 'Decision retrieved successfully');
    res.status(200).json(decision);
  } catch (error) {
    logger.error({ correlationId, error }, 'Failed to retrieve decision');
    res.status(500).json({
      error: 'internal_error',
      message: 'Failed to retrieve decision',
      correlationId,
    });
  }
}

/**
 * GET /v1/decisions - List decisions with optional filtering
 * Query params: objective (substring search), limit, offset
 */
export async function listDecisionsHandler(
  req: Request,
  res: Response,
  dbClient: DatabaseClient
): Promise<void> {
  const correlationId = getOrCreateCorrelationId(req.headers);
  res.setHeader('x-correlation-id', correlationId);

  try {
    const { objective, limit = '50', offset = '0' } = req.query;

    // Validate and sanitize pagination
    const parsedLimit = Math.min(Math.max(parseInt(limit as string, 10) || 50, 1), 1000);
    const parsedOffset = Math.max(parseInt(offset as string, 10) || 0, 0);

    // Build query with filters
    const conditions: string[] = [];
    const params: unknown[] = [];
    let paramIndex = 1;

    // Support filtering by objective substring (case-insensitive ILIKE)
    if (objective && typeof objective === 'string' && objective.trim().length > 0) {
      conditions.push(`objective ILIKE $${paramIndex}`);
      params.push(`%${objective.trim()}%`);
      paramIndex++;
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    // Get total count
    const countQuery = `SELECT COUNT(*) as total FROM decisions ${whereClause}`;
    const countResult = await dbClient.query<{ total: string }>(countQuery, params);
    const total = parseInt(countResult.rows[0]?.total || '0', 10);

    // Get decisions with pagination, biased by learning weights
    // JOIN with learning_weights to favor approved patterns
    // Weight is accumulated from approval signals: positive = approved, negative = rejected
    const selectQuery = `
      SELECT d.id, d.objective, d.command, d.raw_output_hash, d.recommendation, d.confidence,
             d.signals, d.embedding_text, d.embedding, d.graph_relations, d.created_at,
             COALESCE(lw.weight, 0) as approval_weight
      FROM decisions d
      LEFT JOIN learning_weights lw ON lw.source_type = 'decision'
        AND lw.source_id = d.id::text
        AND lw.target_type = 'recommendation'
      ${whereClause}
      ORDER BY COALESCE(lw.weight, 0) DESC, d.created_at DESC
      LIMIT $${paramIndex} OFFSET $${paramIndex + 1}
    `;
    params.push(parsedLimit, parsedOffset);

    const result = await dbClient.query<DecisionRecord>(selectQuery, params);

    const decisions: DecisionRecord[] = result.rows.map(row => ({
      id: row.id,
      objective: row.objective,
      command: row.command,
      raw_output_hash: row.raw_output_hash,
      recommendation: row.recommendation,
      confidence: row.confidence,
      signals: row.signals,
      embedding_text: row.embedding_text,
      embedding: row.embedding,
      graph_relations: row.graph_relations,
      created_at: new Date(row.created_at).toISOString(),
    }));

    logger.info(
      { correlationId, objective, count: decisions.length, total },
      'Decisions listed successfully'
    );

    const response: ListDecisionsResponse = {
      data: decisions,
      total,
      limit: parsedLimit,
      offset: parsedOffset,
    };

    res.status(200).json(response);
  } catch (error) {
    logger.error({ correlationId, error }, 'Failed to list decisions');
    res.status(500).json({
      error: 'internal_error',
      message: 'Failed to list decisions',
      correlationId,
    });
  }
}

export default {
  createDecisionHandler,
  getDecisionHandler,
  listDecisionsHandler,
  createDecisionSchema,
};
