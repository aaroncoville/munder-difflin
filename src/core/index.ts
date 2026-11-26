/**
 * The library surface of src/core: logic that runs without Electron.
 *
 * Modules here may import from each other, from src/shared, and from Node
 * builtins and npm packages, but never from src/main, src/preload,
 * src/renderer, electron, or node-pty. test/core-boundary.test.cjs enforces
 * that, so the folder stays usable outside the app process.
 */
export {};
