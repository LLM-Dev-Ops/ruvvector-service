/**
 * TypeScript interfaces for ruvvector-service
 * Based on SPARC specification
 */

// ============================================================================
// Normalized Event Structure
// ============================================================================

export interface NormalizedEvent {
  eventId: string;          // UUID, caller-generated
  correlationId: string;    // UUID, for request tracing
  timestamp: string;        // ISO 8601 UTC
  vector: number[];         // Embedding vector
  payload: object;          // Arbitrary JSON
  metadata: {
    source: string;         // Originating system identifier
    type: string;           // Event type classification
    version: string;        // Schema version
  };
}

// ============================================================================
// Ingest Endpoint Interfaces
// ============================================================================

export interface IngestRequest extends NormalizedEvent {}

export interface IngestResponse {
  eventId: string;
  vectorId: string;
  status: 'stored';
  timestamp: string;
  metadata: {
    correlationId: string;
    processingTime: number;  // Milliseconds
  };
}

// ============================================================================
// Query Endpoint Interfaces
// ============================================================================

export interface QueryRequest {
  queryVector?: number[] | null;  // Optional, for similarity search
  filters?: {
    source?: string | string[];
    type?: string | string[];
    metadata?: object;              // Key-value filters
  };
  timeRange?: {
    start: string;                  // ISO 8601
    end: string;                    // ISO 8601
  };
  limit?: number;                   // Optional, default 100, max 1000
  offset?: number;                  // Optional, default 0
}

export interface QueryResult {
  eventId: string;
  similarity: number | null;        // Present if queryVector provided
  timestamp: string;
  payload: object;
  metadata: object;
}

export interface QueryResponse {
  results: QueryResult[];
  pagination: {
    total: number;
    limit: number;
    offset: number;
    hasMore: boolean;
  };
  metadata: {
    correlationId: string;
    queryTime: number;              // Milliseconds
  };
}

// ============================================================================
// Simulate Endpoint Interfaces
// ============================================================================

export interface SimulateRequest {
  contextVectors: number[][];       // Required, 1 or more context vectors
  nearestNeighbors?: number;        // Optional, default 10, max 100
  similarityThreshold?: number;     // Optional, default 0.0, range [0, 1]
  includeMetadata?: boolean;        // Optional, default true
  includeVectors?: boolean;         // Optional, default false
}

export interface SimulateNeighbor {
  eventId: string;
  similarity: number;
  vector?: number[] | null;         // Present if includeVectors true
  payload: object;
  metadata?: object | null;         // Present if includeMetadata true
}

export interface SimulateResult {
  contextIndex: number;             // Index of input context vector
  neighbors: SimulateNeighbor[];
}

export interface SimulateResponse {
  results: SimulateResult[];
  execution: {
    vectorsProcessed: number;
    executionTime: number;          // Milliseconds
    correlationId: string;
  };
}

// ============================================================================
// Error Response Interface
// ============================================================================

export interface ErrorResponse {
  error: string;                    // Error code (snake_case)
  message: string;                  // Human-readable message
  correlationId: string;            // Request correlation ID
  details?: any[];                  // Optional additional details
}

// ============================================================================
// Health and Readiness Interfaces
// ============================================================================

export interface HealthResponse {
  status: 'healthy';
  timestamp: string;
}

export interface ReadyResponse {
  status: 'ready' | 'not ready';
  dependencies: {
    ruvvector: 'connected' | 'disconnected';
  };
  timestamp?: string;
}

// ============================================================================
// Entitlement Context Interface
// ============================================================================

export interface EntitlementContext {
  tenant: string;                   // Required
  scope: string;                    // Required
  tier?: string;                    // Optional, not enforced
  limits?: object;                  // Optional, not enforced
}

// ============================================================================
// VectorClient Operation Interfaces
// ============================================================================

export interface VectorInsertParams {
  id: string;
  vector: number[];
  payload: object;
  metadata: object;
}

export interface VectorInsertResult {
  id: string;
}

export interface VectorQueryParams {
  vector?: number[];                // Optional similarity search
  filters?: object;                 // Metadata filters
  timeRange?: {
    start: string;
    end: string;
  };
  limit: number;
  offset: number;
}

export interface VectorQueryResult {
  items: Array<{
    id: string;
    score?: number;
    vector?: number[];
    payload: object;
    metadata: object;
  }>;
  total: number;
  executionTime: number;            // Milliseconds
}

export interface VectorSimilarityParams {
  contextVectors: number[][];
  k: number;                        // Number of nearest neighbors
  threshold: number;                // Similarity threshold [0, 1]
  includeMetadata: boolean;
}

export interface VectorSimilarityResult {
  neighbors: Array<{
    id: string;
    score: number;
    vector?: number[];
    payload: object;
    metadata?: object;
  }>;
  processed: number;                // Number of vectors processed
  executionTime: number;            // Milliseconds
}

// ============================================================================
// Prediction Operation Interfaces (Layer 3 Contract)
// ============================================================================

export interface PredictionParams {
  model: string;                    // Model identifier
  input: number[] | object;         // Vector or structured input
}

export interface PredictionResult {
  model: string;                    // Model used
  output: object;                   // Model output (structure depends on model)
  confidence: number;               // Confidence score [0, 1]
  executionTime: number;            // Milliseconds
}

// ============================================================================
// Plans Storage Interfaces (Cloud Run API)
// ============================================================================

export interface RuvectorPlan {
  id: string;                       // UUID from planner
  type: 'plan';
  intent: string;                   // Original user intent/query
  plan: object;                     // Full plan JSON from planner
  created_at: string;               // ISO timestamp
  org_id: string;                   // Organization ID
  user_id: string;                  // User ID
  checksum: string;                 // SHA-256 of plan content
}

export interface CreatePlanRequest {
  id: string;
  intent: string;
  plan: object;
  org_id: string;
  user_id: string;
  checksum: string;
}

export interface CreatePlanResponse {
  success: boolean;
  id: string;
}

export interface ListPlansResponse {
  plans: RuvectorPlan[];
}

export interface DeletePlanResponse {
  success: boolean;
}

// ============================================================================
// Deployments Storage Interfaces (Cloud Run API)
// ============================================================================

export type DeploymentEnvironment = 'development' | 'staging' | 'production';
export type DeploymentStatus = 'pending' | 'previewed' | 'running' | 'completed' | 'failed' | 'rolled_back';

export interface DeploymentPreviewChange {
  resource: string;
  action: 'create' | 'update' | 'delete' | 'unchanged';
  details: string;
}

export interface DeploymentPreview {
  changes: DeploymentPreviewChange[];
  estimated_duration_seconds: number;
  risk_level: 'low' | 'medium' | 'high';
  requires_approval: boolean;
  generated_at: string;
}

export interface DeploymentExecution {
  started_at: string;
  completed_at?: string;
  steps_completed: number;
  steps_total: number;
  advisory: boolean;
  logs: string[];
}

export interface Deployment {
  id: string;                           // UUID
  target_id: string;                    // Simulation or plan ID
  environment: DeploymentEnvironment;
  status: DeploymentStatus;
  preview: DeploymentPreview | null;
  execution: DeploymentExecution | null;
  created_at: string;                   // ISO timestamp
  updated_at: string;                   // ISO timestamp
  version: number;                      // For optimistic locking
  metadata: Record<string, unknown> | null;
}

export interface CreateDeploymentRequest {
  id: string;
  target_id: string;
  environment: DeploymentEnvironment;
  status: DeploymentStatus;
  preview?: DeploymentPreview | null;
  execution?: DeploymentExecution | null;
  created_at?: string;
  updated_at?: string;
  version?: number;
  metadata?: Record<string, unknown> | null;
}

export interface CreateDeploymentResponse {
  id: string;
  created: boolean;
}

export interface UpdateDeploymentRequest {
  status?: DeploymentStatus;
  execution?: DeploymentExecution | null;
  preview?: DeploymentPreview | null;
  updated_at?: string;
  version?: number;
  metadata?: Record<string, unknown> | null;
}

export interface ListDeploymentsResponse {
  data: Deployment[];
  total: number;
  limit: number;
  offset: number;
}

export interface DeleteDeploymentResponse {
  deleted: boolean;
  id: string;
}

// ============================================================================
// Decisions Storage Interfaces (Executive Synthesis)
// ============================================================================

export interface DecisionSignals {
  financial: string;           // Financial assessment summary
  risk: string;                // Risk assessment summary
  complexity: string;          // Complexity assessment summary
}

export interface DecisionGraphRelations {
  objective_to_repos: string[];                // e.g., ["agentics-simulation-engine"]
  repos_to_signals: Record<string, string[]>;  // e.g., {"repo": ["financial", "risk"]}
  signals_to_recommendation: string[];         // e.g., ["PROCEED"]
}

export interface DecisionRecord {
  id: string;                           // UUID
  objective: string;                    // User intent string
  command: string;                      // e.g., "agentics simulate"
  raw_output_hash: string;              // SHA-256 hash of simulation JSON
  recommendation: string;               // "PROCEED: ...", "DEFER: ...", etc.
  confidence: string;                   // Freeform confidence (e.g., "LOW - Insufficient data")
  signals: DecisionSignals;
  embedding_text: string;               // Text for vector embedding
  embedding?: number[] | null;          // Vector embedding (optional)
  graph_relations: DecisionGraphRelations;
  created_at: string;                   // ISO timestamp
}

export interface CreateDecisionRequest {
  id: string;
  objective: string;
  command: string;
  raw_output_hash: string;
  recommendation: string;
  confidence: string;
  signals: DecisionSignals;
  embedding_text: string;
  graph_relations: DecisionGraphRelations;
  created_at?: string;
}

export interface CreateDecisionResponse {
  id: string;
  created: boolean;
  decision: DecisionRecord;
}

export interface ListDecisionsResponse {
  data: DecisionRecord[];
  total: number;
  limit: number;
  offset: number;
}

// ============================================================================
// Decision Approval & Learning Interfaces
// ============================================================================

export interface ApprovalEvent {
  decision_id: string;                  // UUID of the decision
  approved: boolean;                    // true = positive reward, false = negative
  confidence_adjustment?: number;       // Optional adjustment to confidence weight
  timestamp: string;                    // ISO timestamp
}

export interface ApprovalRecord extends ApprovalEvent {
  id: string;                           // Approval record UUID
  reward: number;                       // Computed reward: +1.0 or -1.0
  created_at: string;                   // ISO timestamp
}

export interface LearningWeight {
  id: string;                           // Weight record UUID
  source_type: 'decision' | 'signal' | 'objective';
  source_id: string;                    // Source entity identifier
  target_type: 'recommendation';
  target_value: string;                 // e.g., "PROCEED", "DEFER"
  weight: number;                       // Accumulated weight from approvals
  update_count: number;                 // Number of updates
  created_at: string;
  updated_at: string;
}

export interface CreateApprovalRequest {
  decision_id: string;
  approved: boolean;
  confidence_adjustment?: number;
  timestamp?: string;
}

export interface CreateApprovalResponse {
  id: string;
  decision_id: string;
  reward: number;
  weights_updated: number;
  learning_applied: boolean;
}

// ============================================================================
// Learning Decision Event Interfaces (PROMPT 0 - Learning Signal Agents)
// ============================================================================

export interface LearningDecisionEvent {
  agent_id: string;                             // Required, agent identifier
  agent_version: string;                        // Required, agent version
  decision_type: 'approval_learning' | 'feedback_assimilation';
  inputs_hash: string;                          // SHA-256 of inputs
  outputs: object;                              // Learning outputs
  confidence: number;                           // 0-1 learning signal strength
  constraints_applied: object;                  // Review scope, artifact type, reviewer role
  execution_ref: string;                        // Execution reference
  timestamp: string;                            // UTC ISO 8601
}

export interface ApprovalLearningEvent extends LearningDecisionEvent {
  decision_type: 'approval_learning';
  source_decision_id: string;                   // Original decision ID
  approved: boolean;                            // Approval outcome
  reviewer_outcome: 'approved' | 'rejected' | 'deferred';
  normalized_signal: number;                    // -1 to +1
  signal_metadata: {
    reviewer_role: string;
    review_scope: string;
    artifact_type: string;
  };
}

export interface FeedbackAssimilationEvent extends LearningDecisionEvent {
  decision_type: 'feedback_assimilation';
  source_artifact_id: string;                   // Source artifact ID
  feedback_type: 'qualitative' | 'quantitative' | 'mixed';
  raw_feedback: string;                         // Raw feedback content
  normalized_signals: Array<{
    dimension: string;
    value: number;
    confidence: number;
  }>;
  assimilation_metadata: {
    feedback_source: string;
    processing_method: string;
  };
}

export interface CreateApprovalLearningRequest {
  agent_id: string;
  agent_version: string;
  source_decision_id: string;
  approved: boolean;
  reviewer_outcome: 'approved' | 'rejected' | 'deferred';
  normalized_signal: number;
  signal_metadata: {
    reviewer_role: string;
    review_scope: string;
    artifact_type: string;
  };
  outputs: object;
  confidence: number;
  constraints_applied: object;
  execution_ref: string;
  inputs_hash: string;
  timestamp?: string;
}

export interface CreateApprovalLearningResponse {
  id: string;
  agent_id: string;
  decision_type: 'approval_learning';
  source_decision_id: string;
  normalized_signal: number;
  created: boolean;
  timestamp: string;
}

export interface CreateFeedbackAssimilationRequest {
  agent_id: string;
  agent_version: string;
  source_artifact_id: string;
  feedback_type: 'qualitative' | 'quantitative' | 'mixed';
  raw_feedback: string;
  normalized_signals: Array<{
    dimension: string;
    value: number;
    confidence: number;
  }>;
  assimilation_metadata: {
    feedback_source: string;
    processing_method: string;
  };
  outputs: object;
  confidence: number;
  constraints_applied: object;
  execution_ref: string;
  inputs_hash: string;
  timestamp?: string;
}

export interface CreateFeedbackAssimilationResponse {
  id: string;
  agent_id: string;
  decision_type: 'feedback_assimilation';
  source_artifact_id: string;
  feedback_type: 'qualitative' | 'quantitative' | 'mixed';
  normalized_signals_count: number;
  created: boolean;
  timestamp: string;
}
