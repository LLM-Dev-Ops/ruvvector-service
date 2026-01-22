/**
 * Configuration interface matching SPARC specification
 * All configuration via environment variables only - NO .env files, NO defaults for required vars
 */
interface Config {
  // Service configuration
  port: number;
  logLevel: string;

  // RuvVector connection (infra-provisioned)
  ruvVector: {
    serviceUrl: string;   // REQUIRED: Full service URL (e.g., http://ruvvector:6379)
    apiKey?: string;      // OPTIONAL: API key if authentication required
    timeout: number;      // Request timeout (ms)
    poolSize: number;     // Connection pool size
  };

  // PostgreSQL Database configuration (for plans storage)
  database: {
    host: string;
    port: number;
    name: string;
    user: string;
    password: string;
    maxConnections: number;
    idleTimeoutMs: number;
    connectionTimeoutMs: number;
    ssl: boolean;
  };

  // Circuit breaker configuration
  circuitBreaker: {
    threshold: number;    // Failures before opening
    timeout: number;      // Open state duration (ms)
    resetTimeout: number; // Time before full reset (ms)
  };

  // Metrics configuration
  metrics: {
    enabled: boolean;
    port: number;
  };

  // Shutdown configuration
  shutdown: {
    timeout: number;      // Graceful shutdown (ms)
  };
}

/**
 * Get optional environment variable with default
 */
const getEnvVar = (key: string, defaultValue: string): string => {
  const value = process.env[key];
  return value !== undefined && value !== '' ? value : defaultValue;
};

/**
 * Get optional environment variable (may be undefined)
 */
const getOptionalEnvVar = (key: string): string | undefined => {
  const value = process.env[key];
  return value !== undefined && value !== '' ? value : undefined;
};

const getEnvNumber = (key: string, defaultValue: number): number => {
  const value = process.env[key];
  if (value === undefined) {
    return defaultValue;
  }
  const parsed = parseInt(value, 10);
  if (isNaN(parsed)) {
    throw new Error(`Environment variable ${key} must be a valid number`);
  }
  return parsed;
};

const getEnvBoolean = (key: string, defaultValue: boolean): boolean => {
  const value = process.env[key];
  if (value === undefined) {
    return defaultValue;
  }
  return value.toLowerCase() === 'true';
};

/**
 * Configuration object - SPARC compliant
 * All values from environment variables
 */
export const config: Config = {
  // Required environment variables
  port: getEnvNumber('PORT', 3000),
  logLevel: getEnvVar('LOG_LEVEL', 'info'),

  // RuvVector connection - RUVVECTOR_SERVICE_URL with default for local dev
  ruvVector: {
    serviceUrl: getEnvVar('RUVVECTOR_SERVICE_URL', 'http://localhost:6379'),
    apiKey: getOptionalEnvVar('RUVVECTOR_API_KEY'),
    timeout: getEnvNumber('RUVVECTOR_TIMEOUT', 30000),
    poolSize: getEnvNumber('RUVVECTOR_POOL_SIZE', 10),
  },

  // PostgreSQL Database configuration (for plans storage)
  database: {
    host: getEnvVar('RUVVECTOR_DB_HOST', 'localhost'),
    port: getEnvNumber('RUVVECTOR_DB_PORT', 5432),
    name: getEnvVar('RUVVECTOR_DB_NAME', 'ruvector-postgres'),
    user: getEnvVar('RUVVECTOR_DB_USER', 'postgres'),
    password: getEnvVar('RUVVECTOR_DB_PASSWORD', ''),
    maxConnections: getEnvNumber('RUVVECTOR_DB_MAX_CONNECTIONS', 20),
    idleTimeoutMs: getEnvNumber('RUVVECTOR_DB_IDLE_TIMEOUT', 30000),
    connectionTimeoutMs: getEnvNumber('RUVVECTOR_DB_CONNECTION_TIMEOUT', 10000),
    ssl: getEnvBoolean('RUVVECTOR_DB_SSL', false),
  },

  // Circuit breaker
  circuitBreaker: {
    threshold: getEnvNumber('CIRCUIT_BREAKER_THRESHOLD', 5),
    timeout: getEnvNumber('CIRCUIT_BREAKER_TIMEOUT', 30000),
    resetTimeout: getEnvNumber('CIRCUIT_BREAKER_RESET', 60000),
  },

  // Metrics
  metrics: {
    enabled: getEnvBoolean('METRICS_ENABLED', true),
    port: getEnvNumber('METRICS_PORT', 9090),
  },

  // Shutdown
  shutdown: {
    timeout: getEnvNumber('SHUTDOWN_TIMEOUT', 30000),
  },
};

export default config;
