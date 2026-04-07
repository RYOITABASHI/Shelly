# Chelly — Chat OSS Extraction

Staged files from Shelly's Chat tab, to be extracted as a standalone OSS chat component.

## Status: Staging (not a runtime dependency)

## Files
- components/ — Chat UI components (bubbles, lists, templates)
- store/chat-store.ts — Chat session/message state
- hooks/use-ai-dispatch.ts — Multi-agent AI routing
- ChatScreen.tsx — Original chat tab entry point

## TODO for standalone
- [ ] Remove Shelly-specific imports (@/store/terminal-store, etc)
- [ ] Create standalone package.json
- [ ] Add Expo/RN peer dependencies
- [ ] Publish to npm as @shelly/chelly
