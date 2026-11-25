// Expo Router native-intent hook. A `hayato://chat/<slug>` VIEW intent would
// otherwise be matched against app/ as the path /chat/<slug> and land on the
// "Unmatched Route" page. RootLayout's Linking listener handles the link
// itself (display + enqueue only, lib/hayato-chat-link.ts), so route every
// hayato: URI to the normal home screen. Other URLs pass through unchanged.
export function redirectSystemPath({ path }: { path: string; initial: boolean }): string {
  return typeof path === 'string' && /^hayato:/i.test(path) ? '/' : path;
}
