/**
 * Configuration tests - SPARC Compliant
 *
 * NOTE: These tests require RUVVECTOR_SERVICE_URL to be set in the test environment.
 * The test setup (tests/setup.ts) should set this environment variable.
 */

describe('Configuration - SPARC Compliant', () => {
  // Store original env
  const originalEnv = process.env;

  beforeAll(() => {
    // Ensure RUVVECTOR_SERVICE_URL is set for tests
    process.env.RUVVECTOR_SERVICE_URL = process.env.RUVVECTOR_SERVICE_URL || 'http://test-ruvvector:6379';
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  // Import config after env setup
  const getConfig = () => {
    jest.resetModules();
    return require('../../src/config').config;
  };

  it('should load basic configuration from environment variables', () => {
    const config = getConfig();
    expect(config).toBeDefined();
    expect(config.port).toBeGreaterThan(0);
    expect(config.logLevel).toBeDefined();
  });

  it('should have RuvVector configuration with serviceUrl (SPARC env vars)', () => {
    const config = getConfig();
    expect(config.ruvVector).toBeDefined();
    expect(config.ruvVector.serviceUrl).toBeDefined();
    expect(typeof config.ruvVector.serviceUrl).toBe('string');
    expect(config.ruvVector.timeout).toBeGreaterThan(0);
    expect(config.ruvVector.poolSize).toBeGreaterThan(0);
  });

  it('should allow optional apiKey', () => {
    const config = getConfig();
    // apiKey is optional, so it may be undefined
    expect(config.ruvVector.apiKey === undefined || typeof config.ruvVector.apiKey === 'string').toBe(true);
  });

  it('should have circuit breaker configuration', () => {
    const config = getConfig();
    expect(config.circuitBreaker).toBeDefined();
    expect(config.circuitBreaker.threshold).toBeGreaterThan(0);
    expect(config.circuitBreaker.timeout).toBeGreaterThan(0);
    expect(config.circuitBreaker.resetTimeout).toBeGreaterThan(0);
  });

  it('should have metrics configuration', () => {
    const config = getConfig();
    expect(config.metrics).toBeDefined();
    expect(typeof config.metrics.enabled).toBe('boolean');
    expect(config.metrics.port).toBeGreaterThan(0);
  });

  it('should have shutdown configuration', () => {
    const config = getConfig();
    expect(config.shutdown).toBeDefined();
    expect(config.shutdown.timeout).toBeGreaterThan(0);
  });

  describe('Default value behavior', () => {
    it('should use default RUVVECTOR_SERVICE_URL when not provided', () => {
      const originalUrl = process.env.RUVVECTOR_SERVICE_URL;
      delete process.env.RUVVECTOR_SERVICE_URL;

      jest.resetModules();
      const { config: testConfig } = require('../../src/config');

      // Should use default value instead of throwing
      expect(testConfig.ruvVector.serviceUrl).toBe('http://localhost:6379');

      // Restore
      process.env.RUVVECTOR_SERVICE_URL = originalUrl;
    });
  });
});
