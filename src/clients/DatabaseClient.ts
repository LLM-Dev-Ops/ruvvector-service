/**
 * PostgreSQL Database Client with Connection Pooling
 * For Google Cloud SQL PostgreSQL
 */
import { Pool, PoolClient, QueryResult, QueryResultRow } from 'pg';
import logger from '../utils/logger';

export interface DatabaseConfig {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
  maxConnections: number;
  idleTimeoutMs: number;
  connectionTimeoutMs: number;
  ssl?: boolean;
}

/**
 * Database client with connection pooling for PostgreSQL
 */
export class DatabaseClient {
  private pool: Pool;
  private initialized: boolean = false;

  constructor(config: DatabaseConfig) {
    this.pool = new Pool({
      host: config.host,
      port: config.port,
      database: config.database,
      user: config.user,
      password: config.password,
      max: config.maxConnections,
      idleTimeoutMillis: config.idleTimeoutMs,
      connectionTimeoutMillis: config.connectionTimeoutMs,
      ssl: config.ssl ? { rejectUnauthorized: false } : false,
    });

    // Pool error handler
    this.pool.on('error', (err) => {
      logger.error({ error: err }, 'Unexpected database pool error');
    });
  }

  /**
   * Initialize the database and create tables if needed
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;

    try {
      // Create plans table if it doesn't exist
      await this.pool.query(`
        CREATE TABLE IF NOT EXISTS plans (
          id UUID PRIMARY KEY,
          type VARCHAR(50) NOT NULL DEFAULT 'plan',
          intent TEXT NOT NULL,
          plan JSONB NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          org_id VARCHAR(255) NOT NULL,
          user_id VARCHAR(255) NOT NULL,
          checksum VARCHAR(64) NOT NULL
        )
      `);

      // Create indexes if they don't exist
      await this.pool.query(`
        CREATE INDEX IF NOT EXISTS idx_plans_org_id ON plans(org_id)
      `);

      await this.pool.query(`
        CREATE INDEX IF NOT EXISTS idx_plans_created_at ON plans(created_at DESC)
      `);

      // Create deployments table if it doesn't exist
      await this.pool.query(`
        CREATE TABLE IF NOT EXISTS deployments (
          id UUID PRIMARY KEY,
          target_id VARCHAR(255) NOT NULL,
          environment VARCHAR(20) NOT NULL CHECK (environment IN ('development', 'staging', 'production')),
          status VARCHAR(20) NOT NULL CHECK (status IN ('pending', 'previewed', 'running', 'completed', 'failed', 'rolled_back')),
          preview JSONB,
          execution JSONB,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          version INTEGER NOT NULL DEFAULT 1,
          metadata JSONB
        )
      `);

      // Create indexes for deployments
      await this.pool.query(`
        CREATE INDEX IF NOT EXISTS idx_deployments_environment ON deployments(environment)
      `);

      await this.pool.query(`
        CREATE INDEX IF NOT EXISTS idx_deployments_status ON deployments(status)
      `);

      await this.pool.query(`
        CREATE INDEX IF NOT EXISTS idx_deployments_created ON deployments(created_at DESC)
      `);

      await this.pool.query(`
        CREATE INDEX IF NOT EXISTS idx_deployments_target ON deployments(target_id)
      `);

      // Create decisions table if it doesn't exist
      // Note: Using TEXT for id and confidence to support flexible formats from agentics-cli
      // First, try to drop the old table with UUID constraints (dev environment migration)
      try {
        // Check if old table exists with UUID type and drop it
        const tableCheck = await this.pool.query(`
          SELECT data_type FROM information_schema.columns
          WHERE table_name = 'decisions' AND column_name = 'id'
        `);
        if (tableCheck.rows.length > 0 && tableCheck.rows[0].data_type === 'uuid') {
          logger.info('Migrating decisions table from UUID to TEXT schema');
          await this.pool.query('DROP TABLE IF EXISTS approvals CASCADE');
          await this.pool.query('DROP TABLE IF EXISTS decisions CASCADE');
        }
      } catch (migrationError) {
        logger.warn({ error: migrationError }, 'Migration check failed, continuing');
      }

      await this.pool.query(`
        CREATE TABLE IF NOT EXISTS decisions (
          id TEXT PRIMARY KEY,
          objective TEXT NOT NULL,
          command TEXT NOT NULL,
          raw_output_hash TEXT NOT NULL,
          recommendation TEXT NOT NULL,
          confidence TEXT NOT NULL,
          signals JSONB NOT NULL,
          embedding_text TEXT NOT NULL,
          embedding JSONB,
          graph_relations JSONB NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);

      // Create indexes for decisions
      await this.pool.query(`
        CREATE INDEX IF NOT EXISTS idx_decisions_created_at ON decisions(created_at DESC)
      `);

      await this.pool.query(`
        CREATE INDEX IF NOT EXISTS idx_decisions_objective ON decisions USING gin(to_tsvector('english', objective))
      `);

      await this.pool.query(`
        CREATE INDEX IF NOT EXISTS idx_decisions_confidence ON decisions(confidence)
      `);

      // Create approvals table for storing approval/rejection events
      await this.pool.query(`
        CREATE TABLE IF NOT EXISTS approvals (
          id UUID PRIMARY KEY,
          decision_id TEXT NOT NULL REFERENCES decisions(id) ON DELETE CASCADE,
          approved BOOLEAN NOT NULL,
          confidence_adjustment DOUBLE PRECISION,
          reward DOUBLE PRECISION NOT NULL,
          timestamp TIMESTAMPTZ NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);

      await this.pool.query(`
        CREATE INDEX IF NOT EXISTS idx_approvals_decision_id ON approvals(decision_id)
      `);

      await this.pool.query(`
        CREATE INDEX IF NOT EXISTS idx_approvals_created_at ON approvals(created_at DESC)
      `);

      // Create learning_weights table for storing edge weights
      await this.pool.query(`
        CREATE TABLE IF NOT EXISTS learning_weights (
          id UUID PRIMARY KEY,
          source_type VARCHAR(20) NOT NULL CHECK (source_type IN ('decision', 'signal', 'objective')),
          source_id TEXT NOT NULL,
          target_type VARCHAR(20) NOT NULL DEFAULT 'recommendation',
          target_value TEXT NOT NULL,
          weight DOUBLE PRECISION NOT NULL DEFAULT 0.0,
          update_count INTEGER NOT NULL DEFAULT 0,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          UNIQUE(source_type, source_id, target_type, target_value)
        )
      `);

      await this.pool.query(`
        CREATE INDEX IF NOT EXISTS idx_learning_weights_source ON learning_weights(source_type, source_id)
      `);

      await this.pool.query(`
        CREATE INDEX IF NOT EXISTS idx_learning_weights_target ON learning_weights(target_value)
      `);

      await this.pool.query(`
        CREATE INDEX IF NOT EXISTS idx_learning_weights_weight ON learning_weights(weight DESC)
      `);

      // Create learning_events table for storing all DecisionEvents from agents
      // This is an append-only audit table - records are never updated or deleted
      await this.pool.query(`
        CREATE TABLE IF NOT EXISTS learning_events (
          id UUID PRIMARY KEY,
          agent_id VARCHAR(100) NOT NULL,
          agent_version VARCHAR(50) NOT NULL,
          decision_type VARCHAR(50) NOT NULL CHECK (decision_type IN ('approval_learning', 'feedback_assimilation')),
          inputs_hash VARCHAR(64) NOT NULL,
          outputs JSONB NOT NULL,
          confidence DOUBLE PRECISION NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
          constraints_applied JSONB NOT NULL,
          execution_ref VARCHAR(255),
          source_id VARCHAR(255),
          source_type VARCHAR(50),
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);

      // Create learning_decision_events table for feedback assimilation agent
      // This is an append-only audit table - records are never updated or deleted
      await this.pool.query(`
        CREATE TABLE IF NOT EXISTS learning_decision_events (
          id UUID PRIMARY KEY,
          event_type VARCHAR(50) NOT NULL DEFAULT 'learning_decision',
          agent_id VARCHAR(100) NOT NULL,
          agent_version VARCHAR(50) NOT NULL,
          decision_type VARCHAR(50) NOT NULL CHECK (decision_type IN ('feedback_assimilation', 'approval_learning', 'pattern_recognition')),
          inputs JSONB NOT NULL,
          inputs_hash VARCHAR(64) NOT NULL,
          outputs JSONB NOT NULL,
          confidence DOUBLE PRECISION NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
          constraints_applied JSONB NOT NULL,
          timestamp TIMESTAMPTZ NOT NULL,
          correlation_id VARCHAR(100) NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);

      // Create indexes for learning_events
      await this.pool.query(`
        CREATE INDEX IF NOT EXISTS idx_learning_events_agent_id ON learning_events(agent_id)
      `);

      await this.pool.query(`
        CREATE INDEX IF NOT EXISTS idx_learning_events_decision_type ON learning_events(decision_type)
      `);

      await this.pool.query(`
        CREATE INDEX IF NOT EXISTS idx_learning_events_created_at ON learning_events(created_at DESC)
      `);

      await this.pool.query(`
        CREATE INDEX IF NOT EXISTS idx_learning_events_source ON learning_events(source_type, source_id)
      `);

      await this.pool.query(`
        CREATE INDEX IF NOT EXISTS idx_learning_events_inputs_hash ON learning_events(inputs_hash)
      `);

      // Unique index on inputs_hash for idempotency (ON CONFLICT support)
      await this.pool.query(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_learning_events_inputs_hash_unique ON learning_events(inputs_hash)
      `);

      // Create indexes for learning_decision_events
      await this.pool.query(`
        CREATE INDEX IF NOT EXISTS idx_learning_decision_events_agent_id ON learning_decision_events(agent_id)
      `);

      await this.pool.query(`
        CREATE INDEX IF NOT EXISTS idx_learning_decision_events_decision_type ON learning_decision_events(decision_type)
      `);

      await this.pool.query(`
        CREATE INDEX IF NOT EXISTS idx_learning_decision_events_inputs_hash ON learning_decision_events(inputs_hash, decision_type)
      `);

      await this.pool.query(`
        CREATE INDEX IF NOT EXISTS idx_learning_decision_events_timestamp ON learning_decision_events(timestamp DESC)
      `);

      await this.pool.query(`
        CREATE INDEX IF NOT EXISTS idx_learning_decision_events_created_at ON learning_decision_events(created_at DESC)
      `);

      this.initialized = true;
      logger.info('Database initialized successfully');
    } catch (error) {
      logger.error({ error }, 'Failed to initialize database');
      throw error;
    }
  }

  /**
   * Check database connectivity
   */
  async ping(): Promise<boolean> {
    try {
      const result = await this.pool.query('SELECT 1 as ping');
      return result.rows[0]?.ping === 1;
    } catch (error) {
      logger.error({ error }, 'Database ping failed');
      return false;
    }
  }

  /**
   * Execute a query
   */
  async query<T extends QueryResultRow = QueryResultRow>(text: string, params?: unknown[]): Promise<QueryResult<T>> {
    const start = Date.now();
    try {
      const result = await this.pool.query<T>(text, params);
      const duration = Date.now() - start;
      logger.debug(
        { query: text.substring(0, 100), duration, rowCount: result.rowCount },
        'Query executed'
      );
      return result;
    } catch (error) {
      logger.error({ error, query: text.substring(0, 100) }, 'Query failed');
      throw error;
    }
  }

  /**
   * Get a client from the pool for transactions
   */
  async getClient(): Promise<PoolClient> {
    return this.pool.connect();
  }

  /**
   * Get connection pool statistics
   */
  getPoolStats(): { total: number; idle: number; waiting: number } {
    return {
      total: this.pool.totalCount,
      idle: this.pool.idleCount,
      waiting: this.pool.waitingCount,
    };
  }

  /**
   * Close all connections
   */
  async close(): Promise<void> {
    await this.pool.end();
    logger.info('Database pool closed');
  }
}

export default DatabaseClient;
