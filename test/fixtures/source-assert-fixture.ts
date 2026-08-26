// Fixture for source-assert.test.cjs — read as text, never compiled.
function fixture_start() {
  /* blockedCall() */
  activeCall(); // inlineComment()
  return 42;
}
function fixture_end() {}

// Edge cases: comment tokens inside literals must survive stripping.
const url = "https://example.test/x"; function urlCall() {}
const marker = "/* not a comment */"; function markerCall() {}
const tmpl = `https://x.io/path`; function tmplCall() {}
const re = /\/\//; function reCall() {}
