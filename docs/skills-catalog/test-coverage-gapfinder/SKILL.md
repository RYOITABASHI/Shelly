---
name: test-coverage-gapfinder
description: Find the highest-value untested code paths and propose tests for those first, instead of chasing a coverage percentage.
---
When asked to improve test coverage for a file, module, or recent change,
don't just add tests for whatever is easiest to test — prioritize by risk:

1. **Find what's genuinely untested, not just uncovered by line count.** A
   coverage report's percentage hides which lines matter; read the actual
   logic and identify branches (error paths, edge cases, an "else" that
   never got exercised) rather than optimizing the number itself.
2. **Rank by blast radius, not by ease.** A one-line pure function is easy
   to test but low-risk if wrong; an untested branch in payment, auth, data
   deletion, or a shared utility used everywhere is harder to test but far
   more valuable to cover first.
3. **Write the test for the behavior, not the implementation.** Assert on
   observable outcomes (return value, side effect, thrown error) rather
   than internal call counts or private state, so the test survives a
   refactor that doesn't change behavior.
4. **Include the edge cases a happy-path test skips**: empty/null input,
   the boundary of a range, a concurrent/duplicate call, a downstream
   dependency failing or timing out — these are exactly the paths that
   "looked fine in manual testing" and then broke in production.
5. **Don't fake coverage.** A test that calls a function but asserts
   nothing meaningful (or asserts on a mock's own return value) inflates
   the coverage number without catching any real regression — every new
   test should be able to fail if the logic it covers were broken.
6. **Report gaps you didn't close, not just the ones you did** — if a path
   is untestable without a larger refactor (e.g. a hard external
   dependency), say so explicitly instead of silently leaving it out of
   the summary.
