import express, { Application, Request, Response, NextFunction } from 'express';
import { Server } from 'http';
import { config } from './config';
import logger from './utils/logger';
import {
  register,
  ruvvectorRequestsTotal,
  ruvvectorRequestDuration,
  ruvvectorCircuitBreakerState,
  ruvvectorActiveConnections
} from './utils/metrics';
import { VectorClient } from './clients/VectorClient';
import { DatabaseClient } from './clients/DatabaseClient';

// Startup Hardening
import { runStartupAssertions, verifyStorageHealth } from './startup';
import { configureLatencyBudget, learningLatencyMiddleware } from './middleware/latencyBudget';
import { assertHistoricalDataIntegrity } from './guards/immutability';

// Middleware
import { validateRequiredHeaders, validateRequest, ingestSchema, querySchema, simulateSchema } from './middleware/validation';
import { errorHandler, notFoundHandler } from './middleware/errorHandler';

// Handlers
import { ingestHandler } from './handlers/ingest';
import { queryHandler } from './handlers/query';
import { simulateHandler } from './handlers/simulate';
import { graphHandler } from './handlers/graph';
import { predictHandler } from './handlers/predict';
import { metadataHandler } from './handlers/metadata';
import { healthHandler, readyHandler } from './handlers/health';
import {
  createPlanHandler,
  getPlanHandler,
  listPlansHandler,
  deletePlanHandler,
} from './handlers/plans';
import {
  createDeploymentHandler,
  getDeploymentHandler,
  updateDeploymentHandler,
  listDeploymentsHandler,
  deleteDeploymentHandler,
} from './handlers/deployments';
import {
  createDecisionHandler,
  getDecisionHandler,
  listDecisionsHandler,
} from './handlers/decisions';
import { createApprovalHandler } from './handlers/approvals';
import {
  createApprovalLearningHandler,
  createFeedbackAssimilationHandler,
} from './handlers/learning';
import { listDecisionEventsHandler } from './handlers/decisionEvents';

/**
 * Request metrics middleware - SPARC compliant
 */
function metricsMiddleware(req: Request, res: Response, next: NextFunction): void {
  const startTime = Date.now();
  ruvvectorActiveConnections.inc();

  res.on('finish', () => {
    const duration = (Date.now() - startTime) / 1000;
    const endpoint = req.path;
    const status = res.statusCode.toString();

    ruvvectorRequestDuration.observe({ endpoint }, duration);
    ruvvectorRequestsTotal.inc({ endpoint, status });
    ruvvectorActiveConnections.dec();
  });

  next();
}

/**
 * Initialize Express application with all middleware and routes
 * SPARC compliant with Cloud Run plans API
 */
function createApp(vectorClient: VectorClient, dbClient: DatabaseClient): Application {
  const app = express();

  // Basic middleware
  app.use(express.json({ limit: '10mb' }));

  // Metrics middleware for all requests
  app.use(metricsMiddleware);

  // Health endpoints (no authentication required per SPARC)
  // GET /health - Liveness probe with database check
  app.get('/health', (req, res, next) => {
    healthHandler(req, res, dbClient).catch(next);
  });

  // SPARC: GET /ready - Readiness probe
  app.get('/ready', (req, res, next) => {
    readyHandler(req, res, vectorClient).catch(next);
  });

  // SPARC: GET /metrics - Prometheus metrics
  app.get('/metrics', async (_req, res) => {
    // Update circuit breaker state metric
    const circuitState = vectorClient.getCircuitState();
    ruvvectorCircuitBreakerState.set(circuitState === 'open' ? 1 : 0);

    res.set('Content-Type', register.contentType);
    res.end(await register.metrics());
  });

  // ============================================================================
  // Plans API - /v1/plans endpoints for Cloud Run
  // ============================================================================

  // POST /v1/plans - Store a plan
  app.post('/v1/plans', (req, res, next) => {
    createPlanHandler(req, res, dbClient).catch(next);
  });

  // GET /v1/plans/:id - Retrieve a plan by ID
  app.get('/v1/plans/:id', (req, res, next) => {
    getPlanHandler(req, res, dbClient).catch(next);
  });

  // GET /v1/plans - List plans (with optional org_id and limit query params)
  app.get('/v1/plans', (req, res, next) => {
    listPlansHandler(req, res, dbClient).catch(next);
  });

  // DELETE /v1/plans/:id - Delete a plan
  app.delete('/v1/plans/:id', (req, res, next) => {
    deletePlanHandler(req, res, dbClient).catch(next);
  });

  // ============================================================================
  // Deployments API - /v1/deployments endpoints for Cloud Run
  // ============================================================================

  // POST /v1/deployments - Store a deployment
  app.post('/v1/deployments', (req, res, next) => {
    createDeploymentHandler(req, res, dbClient).catch(next);
  });

  // GET /v1/deployments/:id - Retrieve a deployment by ID
  app.get('/v1/deployments/:id', (req, res, next) => {
    getDeploymentHandler(req, res, dbClient).catch(next);
  });

  // PUT /v1/deployments/:id - Update a deployment
  app.put('/v1/deployments/:id', (req, res, next) => {
    updateDeploymentHandler(req, res, dbClient).catch(next);
  });

  // GET /v1/deployments - List deployments (with optional environment, status, limit, offset query params)
  app.get('/v1/deployments', (req, res, next) => {
    listDeploymentsHandler(req, res, dbClient).catch(next);
  });

  // DELETE /v1/deployments/:id - Delete a deployment
  app.delete('/v1/deployments/:id', (req, res, next) => {
    deleteDeploymentHandler(req, res, dbClient).catch(next);
  });

  // ============================================================================
  // Decisions API - /v1/decisions endpoints for Executive Synthesis
  // ============================================================================

  // POST /v1/decisions - Store a new decision record
  app.post('/v1/decisions', (req, res, next) => {
    createDecisionHandler(req, res, dbClient).catch(next);
  });

  // GET /v1/decisions/:id - Retrieve a decision by ID
  app.get('/v1/decisions/:id', (req, res, next) => {
    getDecisionHandler(req, res, dbClient).catch(next);
  });

  // GET /v1/decisions - List decisions (with optional objective, limit, offset query params)
  app.get('/v1/decisions', (req, res, next) => {
    listDecisionsHandler(req, res, dbClient).catch(next);
  });

  // ============================================================================
  // Decision Approval API - Learning endpoint for executive synthesis
  // ============================================================================

  // POST /decision/approval - Process approval event and apply learning
  app.post('/decision/approval', (req, res, next) => {
    createApprovalHandler(req, res, dbClient).catch(next);
  });

  // ============================================================================
  // Learning Signal Agents API - PROMPT 0 Compliant
  // Memory Layer Hardening: Latency budget enforcement on all learning endpoints
  // ============================================================================

  // POST /learning/learn - Approval Learning Agent (CLI-invokable)
  // Emits ONLY: learning_update_signal
  app.post('/learning/learn', learningLatencyMiddleware, (req, res, next) => {
    createApprovalLearningHandler(req, res, dbClient).catch(next);
  });

  // POST /learning/assimilate - Feedback Assimilation Agent (CLI-invokable)
  // Emits ONLY: feedback_assimilation_signal
  app.post('/learning/assimilate', learningLatencyMiddleware, (req, res, next) => {
    createFeedbackAssimilationHandler(req, res, dbClient).catch(next);
  });

  // GET /learning/inspect - Inspect learning events (read-only)
  app.get('/learning/inspect', async (req, res, next) => {
    try {
      const { limit = '50', offset = '0', decision_type } = req.query;
      const parsedLimit = Math.min(Math.max(parseInt(limit as string, 10) || 50, 1), 1000);
      const parsedOffset = Math.max(parseInt(offset as string, 10) || 0, 0);

      let query = `SELECT id, agent_id, agent_version, decision_type, inputs_hash, outputs, confidence, constraints_applied, source_id, source_type, created_at FROM learning_events`;
      const params: unknown[] = [];

      if (decision_type) {
        query += ` WHERE decision_type = $1`;
        params.push(decision_type);
      }

      query += ` ORDER BY created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
      params.push(parsedLimit, parsedOffset);

      const result = await dbClient.query(query, params);

      res.status(200).json({
        data: result.rows,
        total: result.rowCount,
        limit: parsedLimit,
        offset: parsedOffset,
      });
    } catch (error) {
      next(error);
    }
  });

  // ============================================================================
  // Decision Events API - Execution Engine Consumption Endpoint
  // Allows downstream execution engines to poll for approved plans and events
  // ============================================================================

  // GET /events/decisions - Fetch decision events for execution engines
  // Query params: types (comma-separated), after (cursor), limit
  // Authentication required via x-correlation-id and x-entitlement-context headers
  app.get('/events/decisions', validateRequiredHeaders, (req, res, next) => {
    listDecisionEventsHandler(req, res, dbClient).catch(next);
  });

  // ============================================================================
  // Legacy API endpoints (require x-correlation-id and x-entitlement-context headers)
  // ============================================================================

  // SPARC: POST /ingest - Accept normalized events
  app.post(
    '/ingest',
    validateRequiredHeaders,
    validateRequest(ingestSchema),
    (req, res, next) => {
      ingestHandler(req, res, vectorClient).catch(next);
    }
  );

  // SPARC: POST /query - Retrieve events
  app.post(
    '/query',
    validateRequiredHeaders,
    validateRequest(querySchema),
    (req, res, next) => {
      queryHandler(req, res, vectorClient).catch(next);
    }
  );

  // SPARC: POST /simulate - Execute simulation queries
  app.post(
    '/simulate',
    validateRequiredHeaders,
    validateRequest(simulateSchema),
    (req, res, next) => {
      simulateHandler(req, res, vectorClient).catch(next);
    }
  );

  // POST /graph - Graph operations (stub - TODO: implement)
  app.post(
    '/graph',
    validateRequiredHeaders,
    (req, res, next) => {
      graphHandler(req, res, vectorClient).catch(next);
    }
  );

  // POST /predict - Run ML predictions
  app.post(
    '/predict',
    validateRequiredHeaders,
    (req, res, next) => {
      predictHandler(req, res, vectorClient).catch(next);
    }
  );

  // GET /metadata - Service metadata and capability discovery
  app.get('/metadata', (req, res, next) => {
    metadataHandler(req, res, vectorClient).catch(next);
  });

  // Error handlers (must be last)
  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}

/**
 * Start the HTTP server
 * SPARC: Service listen port from PORT env var, default 3000
 *
 * MEMORY LAYER HARDENING:
 * 1. Assert all env vars
 * 2. Verify storage + index health
 * 3. Crash on failure
 */
async function startServer(): Promise<{ server: Server; dbClient: DatabaseClient }> {
  // ============================================================================
  // STARTUP HARDENING PHASE 1: Environment Assertions
  // CRASHES on failure in production
  // ============================================================================
  const { maxLatencyMs } = runStartupAssertions();
  configureLatencyBudget(maxLatencyMs);

  // ============================================================================
  // STARTUP HARDENING PHASE 2: Database Initialization
  // ============================================================================
  // Initialize DatabaseClient for PostgreSQL
  const dbClient = new DatabaseClient({
    host: config.database.host,
    port: config.database.port,
    database: config.database.name,
    user: config.database.user,
    password: config.database.password,
    maxConnections: config.database.maxConnections,
    idleTimeoutMs: config.database.idleTimeoutMs,
    connectionTimeoutMs: config.database.connectionTimeoutMs,
    ssl: config.database.ssl,
  });

  // Initialize database (create tables if needed)
  await dbClient.initialize();

  // ============================================================================
  // STARTUP HARDENING PHASE 3: Storage Health Verification
  // CRASHES on failure in production
  // ============================================================================
  await verifyStorageHealth(dbClient);

  // ============================================================================
  // STARTUP HARDENING PHASE 4: Historical Data Integrity Check
  // ============================================================================
  const integrityResult = await assertHistoricalDataIntegrity(dbClient);
  if (!integrityResult.valid) {
    logger.warn(
      { issues: integrityResult.issues },
      'Historical data integrity issues detected'
    );
  }

  // Initialize VectorClient with SPARC-compliant config
  const vectorClient = new VectorClient({
    serviceUrl: config.ruvVector.serviceUrl,
    apiKey: config.ruvVector.apiKey,
    timeout: config.ruvVector.timeout,
    poolSize: config.ruvVector.poolSize,
    circuitBreaker: {
      threshold: config.circuitBreaker.threshold,
      timeout: config.circuitBreaker.timeout,
      resetTimeout: config.circuitBreaker.resetTimeout,
    },
  });

  // Establish connection to RuvVector (optional - may not be available)
  try {
    await vectorClient.connect();
  } catch (error) {
    logger.warn({ error }, 'VectorClient connection failed - continuing without vector operations');
  }

  // Create Express app
  const app = createApp(vectorClient, dbClient);

  // Start HTTP server
  const server = app.listen(config.port, () => {
    const connectionInfo = vectorClient.getConnectionInfo();
    const dbStats = dbClient.getPoolStats();
    logger.info(
      {
        port: config.port,
        ruvvectorServiceUrl: connectionInfo.serviceUrl,
        database: {
          host: config.database.host,
          name: config.database.name,
          poolStats: dbStats,
        },
        service: 'ruvvector-service',
      },
      'Server started successfully'
    );
  });

  // SPARC: Request timeout - Configurable, default 30s
  server.timeout = config.ruvVector.timeout;
  server.keepAliveTimeout = 65000;
  server.headersTimeout = 66000;

  return { server, dbClient };
}

/**
 * Graceful shutdown handler
 * SPARC: Drain connections within 30s
 */
function setupGracefulShutdown(server: Server, dbClient: DatabaseClient): void {
  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Received shutdown signal, starting graceful shutdown');

    // Stop accepting new connections
    server.close(() => {
      logger.info('HTTP server closed');
    });

    // SPARC: Graceful shutdown - Drain connections within 30s (configurable)
    const shutdownTimeout = setTimeout(() => {
      logger.error('Graceful shutdown timeout exceeded, forcing exit');
      process.exit(1);
    }, config.shutdown.timeout);

    try {
      await new Promise<void>((resolve) => {
        server.on('close', resolve);
      });

      // Close database connections
      await dbClient.close();

      clearTimeout(shutdownTimeout);
      logger.info('Graceful shutdown completed');
      process.exit(0);
    } catch (error) {
      logger.error({ error }, 'Error during graceful shutdown');
      clearTimeout(shutdownTimeout);
      process.exit(1);
    }
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  process.on('uncaughtException', (error) => {
    logger.fatal({ error }, 'Uncaught exception');
    process.exit(1);
  });

  process.on('unhandledRejection', (reason, promise) => {
    logger.fatal({ reason, promise }, 'Unhandled promise rejection');
    process.exit(1);
  });
}

/**
 * Main entry point
 */
async function main(): Promise<void> {
  try {
    logger.info(
      {
        service: 'ruvvector-service',
        logLevel: config.logLevel,
      },
      'Starting ruvvector-service'
    );

    const { server, dbClient } = await startServer();
    setupGracefulShutdown(server, dbClient);
  } catch (error) {
    logger.fatal({ error }, 'Failed to start server');
    process.exit(1);
  }
}

// Start the application
if (require.main === module) {
  main();
}

export { createApp, startServer };
