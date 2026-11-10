/**
 * A made-up journal article page (v54 source-text trimming and section-keeping
 * tests). Page chrome, a table of contents, a long introduction, the key
 * sections and a reference list, in the order a publisher's HTML page shows
 * them. No real journal, author or study.
 */
const para = (label: string, n: number) => Array.from({ length: n }, (_, i) => `${label} paragraph ${i + 1}: ${'words of the paper '.repeat(12).trim()}.`);

export const JOURNAL_PAGE_HTML = [
  '<html><head><title>Example study</title><script>var x = 1;</script></head><body>',
  '<div>Skip to main content</div>',
  '<p>We use cookies to improve your experience. By continuing you agree to our use of cookies. Manage preferences</p>',
  '<ul><li>Menu</li><li>Search</li><li>Log in</li></ul>',
  '<h1>A made-up study of practice schedules</h1>',
  '<ul><li>Sections</li><li>Abstract</li><li>Introduction</li><li>Methods</li><li>Results</li><li>Discussion</li><li>References</li></ul>',
  '<p>Share</p><p>Share</p><p>Share</p>',
  '<h2>Abstract</h2><p>We compared two practice schedules in a sample of volunteers.</p>',
  '<h2>Introduction</h2>',
  ...para('Introduction', 60).map((p) => `<p>${p}</p>`),
  '<h2>Methods</h2>',
  '<p>FIXTURE-METHODS: forty-two volunteers trained for three hours over two weeks.</p>',
  ...para('Methods', 20).map((p) => `<p>${p}</p>`),
  '<h2>Results</h2>',
  '<p>FIXTURE-RESULTS: the spaced group recalled more items at the delayed test.</p>',
  ...para('Results', 20).map((p) => `<p>${p}</p>`),
  '<h2>Discussion</h2>',
  ...para('Discussion', 15).map((p) => `<p>${p}</p>`),
  '<h3>Limitations</h3>',
  '<p>FIXTURE-LIMITATIONS: the sample was small and all volunteers were students.</p>',
  '<h2>References</h2>',
  '<ol><li>FIXTURE-REFERENCE One, A. (2001). An earlier paper.</li><li>Two, B. (2002). Another paper.</li></ol>',
  '<p>Share</p><p>Back to top</p>',
  '</body></html>',
].join('\n');
