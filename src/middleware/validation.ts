import { Request, Response, NextFunction } from 'express';
import { z, ZodSchema } from 'zod';
import { getOrCreateCorrelationId } from '../utils/correlation';
import { checkEntitlement, EntitlementResult } from '../utils/entitlement';

// Extend Express Request type to include our custom properties
declare global {
  namespace Express {
    interface Request {
      correlationId: string;
      entitlement: EntitlementResult;
    }
  }
}

/**
 * Middleware factory for validating request bodies against Zod schemas
 */
export function validateRequest(schema: ZodSchema) {
  return async (req: Request, _res: Response, next: NextFunction): Promise<void> => {
    try {
      req.body = await schema.parseAsync(req.body);
      next();
    } catch (error) {
      next(error); // Pass to error handler
    }
  };
}

/**
 * Middleware to extract and validate correlation ID
 * SPARC: x-correlation-id header is required
 */
export function extractCorrelationId(req: Request, res: Response, next: NextFunction): void {
  const correlationId = req.headers['x-correlation-id'];

  if (!correlationId || typeof correlationId !== 'string') {
    const generatedId = getOrCreateCorrelationId(req.headers);
    res.status(400).json({
      error: 'missing_header',
      message: 'Missing required header: x-correlation-id',
      correlationId: generatedId,
    });
    return;
  }

  req.correlationId = correlationId;
  res.setHeader('x-correlation-id', correlationId);
  next();
}

/**
 * Middleware to validate entitlement context
 * SPARC: x-entitlement-context header is required (Base64-encoded JSON)
 */
export function validateEntitlement(req: Request, res: Response, next: NextFunction): void {
  const entitlementHeader = req.headers['x-entitlement-context'];
  const correlationId = req.correlationId || getOrCreateCorrelationId(req.headers);

  // Check header presence
  if (!entitlementHeader || typeof entitlementHeader !== 'string') {
    res.status(400).json({
      error: 'missing_header',
      message: 'Missing required header: x-entitlement-context',
      correlationId,
    });
    return;
  }

  // Check entitlement (SPARC stub - validates format only)
  const result = checkEntitlement(entitlementHeader);

  if (!result.allowed) {
    res.status(403).json({
      error: 'entitlement_error',
      message: result.reason || 'Entitlement check failed',
      correlationId,
    });
    return;
  }

  // Store entitlement result on request
  req.entitlement = result;
  next();
}

/**
 * Combined middleware for required headers
 * SPARC requires: x-correlation-id, x-entitlement-context, content-type: application/json
 */
export function validateRequiredHeaders(req: Request, res: Response, next: NextFunction): void {
  const correlationId = req.headers['x-correlation-id'];
  const entitlementContext = req.headers['x-entitlement-context'];
  const contentType = req.headers['content-type'];

  const missing: string[] = [];

  if (!correlationId) missing.push('x-correlation-id');
  if (!entitlementContext) missing.push('x-entitlement-context');
  if (!contentType?.includes('application/json')) {
    const id = typeof correlationId === 'string' ? correlationId : getOrCreateCorrelationId(req.headers);
    res.status(400).json({
      error: 'validation_error',
      message: 'Content-Type must be application/json',
      correlationId: id,
    });
    return;
  }

  if (missing.length > 0) {
    const id = typeof correlationId === 'string' ? correlationId : getOrCreateCorrelationId(req.headers);
    res.status(400).json({
      error: 'missing_header',
      message: `Missing required headers: ${missing.join(', ')}`,
      correlationId: id,
    });
    return;
  }

  // Set correlation ID on request
  req.correlationId = correlationId as string;
  res.setHeader('x-correlation-id', req.correlationId);

  // Check entitlement
  const result = checkEntitlement(entitlementContext as string);

  if (!result.allowed) {
    res.status(403).json({
      error: 'entitlement_error',
      message: result.reason || 'Entitlement check failed',
      correlationId: req.correlationId,
    });
    return;
  }

  req.entitlement = result;
  next();
}

// Zod schemas for SPARC endpoints

export const ingestSchema = z.object({
  eventId: z.string().uuid(),
  correlationId: z.string().uuid(),
  timestamp: z.string().datetime(),
  vector: z.array(z.number()).min(1),
  payload: z.record(z.unknown()),
  metadata: z.object({
    source: z.string().min(1),
    type: z.string().min(1),
    version: z.string().min(1),
  }),
});

export const querySchema = z.object({
  queryVector: z.array(z.number()).min(1).optional().nullable(),
  filters: z.object({
    source: z.union([z.string(), z.array(z.string())]).optional(),
    type: z.union([z.string(), z.array(z.string())]).optional(),
    metadata: z.record(z.unknown()).optional(),
  }).optional(),
  timeRange: z.object({
    start: z.string().datetime(),
    end: z.string().datetime(),
  }).optional(),
  limit: z.number().int().min(1).max(1000).optional(),
  offset: z.number().int().min(0).optional(),
});

export const simulateSchema = z.object({
  contextVectors: z.array(z.array(z.number()).min(1)).min(1),
  nearestNeighbors: z.number().int().min(1).max(100).optional(),
  similarityThreshold: z.number().min(0).max(1).optional(),
  includeMetadata: z.boolean().optional(),
  includeVectors: z.boolean().optional(),
});

/**
 * Tolerant middleware for internal polling endpoints (e.g., execution engine listeners)
 *
 * This middleware is SAFE for:
 * - Stateless polling
 * - First-time consumers
 * - Internal execution engines
 * - Cursor-less initial requests
 *
 * If headers are missing, it auto-generates defaults instead of failing.
 * Authorization is still validated if present.
 */
export function validateInternalPolling(req: Request, res: Response, next: NextFunction): void {
  // Auto-generate correlation ID if missing
  let correlationId = req.headers['x-correlation-id'];
  if (!correlationId || typeof correlationId !== 'string') {
    correlationId = getOrCreateCorrelationId(req.headers);
  }
  req.correlationId = correlationId;
  res.setHeader('x-correlation-id', correlationId);

  // Default entitlement context for internal services if missing
  let entitlementContext = req.headers['x-entitlement-context'];
  if (!entitlementContext || typeof entitlementContext !== 'string') {
    // Default to system execution listener context
    entitlementContext = Buffer.from(JSON.stringify({
      tenant: 'system',
      scope: 'execution-listener'
    })).toString('base64');
  }

  // Validate entitlement if provided (or use default)
  const result = checkEntitlement(entitlementContext);

  if (!result.allowed) {
    res.status(403).json({
      error: 'entitlement_error',
      message: result.reason || 'Entitlement check failed',
      correlationId,
    });
    return;
  }

  req.entitlement = result;
  next();
}

export default {
  validateRequest,
  extractCorrelationId,
  validateEntitlement,
  validateRequiredHeaders,
  validateInternalPolling,
  ingestSchema,
  querySchema,
  simulateSchema,
};
