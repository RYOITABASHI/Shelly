/**
 * Settings that only the Settings UI (ConfigTUI) may turn ON. `shelly config
 * set`, MCP, agents and NL chat may only turn them off. Kept dependency-free
 * so lib/pseudo-shell.ts can import it cheaply.
 */
export const UI_ONLY_ENABLE_SETTINGS: ReadonlySet<string> = new Set(['approveAllWithoutAsking', 'mcpSkipApproval']);
