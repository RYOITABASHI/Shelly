// Manual Jest mock for expo-localization (native module, not available under
// testEnvironment: 'node'). Auto-picked up by Jest for any test that
// transitively imports lib/i18n. Fixed to English so locale-dependent
// assertions in tests stay deterministic regardless of the host machine's
// system language.
module.exports = {
  getLocales: () => [{ languageCode: 'en', languageTag: 'en-US', regionCode: 'US', currencyCode: 'USD' }],
};
