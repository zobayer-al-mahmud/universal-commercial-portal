// Test stub for the `server-only` marker package. In the app it throws if a
// server module is pulled into a client bundle; under vitest (Node) there is no
// such boundary, so it is a harmless no-op that lets server-only libraries be
// unit-tested.
export {};
