# =============================================================================
# RuvVector Service Dockerfile
# SPARC Specification Compliant
#
# Technical Constraints:
# - Runtime: Node.js LTS (20.x)
# - State: Stateless - no local persistence beyond process memory
# - Deployment: Container-ready, single process
# - Startup time: < 5 seconds to healthy
# - Memory footprint: < 256MB baseline
# =============================================================================

# Build stage - use full node image for native dependencies (hnswlib-node requires Python)
FROM node:20 AS builder

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install all dependencies (including devDependencies for build)
RUN npm ci

# Copy source code
COPY tsconfig.json ./
COPY src/ ./src/

# Build TypeScript
RUN npm run build

# Prune dev dependencies for smaller image
RUN npm prune --production

# Production stage - use slim (Debian-based) for compatibility with native modules
FROM node:20-slim AS production

# SPARC: Container-ready, single process
WORKDIR /app

# Create non-root user for security
RUN groupadd -g 1001 nodejs && \
    useradd -u 1001 -g nodejs nodejs

# Copy built application and production dependencies from builder
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./

# Set ownership
RUN chown -R nodejs:nodejs /app

# Switch to non-root user
USER nodejs

# Environment-driven configuration for Cloud Run
ENV NODE_ENV=production
ENV PORT=8080
ENV LOG_LEVEL=info

# Default RuvVector connection (optional for plans-only deployment)
ENV RUVVECTOR_SERVICE_URL=http://localhost:6379
ENV RUVVECTOR_TIMEOUT=30000
ENV RUVVECTOR_POOL_SIZE=10

# Database configuration (Cloud SQL PostgreSQL)
# These should be overridden by Cloud Run environment variables
ENV RUVVECTOR_DB_HOST=localhost
ENV RUVVECTOR_DB_PORT=5432
ENV RUVVECTOR_DB_NAME=ruvector-postgres
ENV RUVVECTOR_DB_USER=postgres
ENV RUVVECTOR_DB_PASSWORD=
ENV RUVVECTOR_DB_MAX_CONNECTIONS=20
ENV RUVVECTOR_DB_IDLE_TIMEOUT=30000
ENV RUVVECTOR_DB_CONNECTION_TIMEOUT=10000
ENV RUVVECTOR_DB_SSL=false

# Circuit breaker defaults
ENV CIRCUIT_BREAKER_THRESHOLD=5
ENV CIRCUIT_BREAKER_TIMEOUT=30000
ENV CIRCUIT_BREAKER_RESET=60000

# Metrics defaults
ENV METRICS_ENABLED=true
ENV METRICS_PORT=9090

# Graceful shutdown
ENV SHUTDOWN_TIMEOUT=30000

# Expose service port (Cloud Run uses 8080)
EXPOSE 8080

# Liveness probe - GET /health with database check
# Startup time < 10 seconds for database connection
HEALTHCHECK --interval=30s --timeout=10s --start-period=10s --retries=3 \
  CMD node -e "require('http').get('http://localhost:8080/health', (r) => process.exit(r.statusCode === 200 ? 0 : 1)).on('error', () => process.exit(1))"

# SPARC: Single process deployment
CMD ["node", "dist/index.js"]
