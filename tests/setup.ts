// Provide a minimal, non-secret environment so modules that import `@/lib/env`
// (e.g. the Damco adapter) can be unit-tested without a real configuration.
process.env.DATABASE_URL ||= "file:./dev.db";
process.env.AUTH_SECRET ||= "test-secret-at-least-16-chars-long";
process.env.INTEGRATION_MODE ||= "mock";
