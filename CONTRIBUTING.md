# Contributing to Shelly

Thank you for considering contributing to Shelly. This is my first open source project, and your involvement means a lot.

## A note about the codebase

This entire codebase was generated through AI conversation (Claude Code). I'm a designer, not a programmer — I can't read or write TypeScript. The code works, but it almost certainly has room for improvement in patterns, performance, and structure.

**If you see something that could be better, that's not a bug report — that's the whole point of going open source.**

## How to contribute

### Reporting bugs

1. Check [existing issues](https://github.com/RYOITABASHI/Shelly/issues) to avoid duplicates.
2. Open a new issue with:
   - What you expected to happen
   - What actually happened
   - Device model and Android version
   - Steps to reproduce

### Suggesting improvements

Open an issue tagged `enhancement`. Code quality improvements, refactoring, and architectural suggestions are especially welcome.

### Submitting a pull request

1. Fork the repository
2. Create a branch: `git checkout -b fix/your-fix-name`
3. Make your changes
4. Test on an Android device or emulator
5. Open a PR with a clear description of what changed and why

### What makes a good PR

- **Focused.** One concern per PR.
- **Explained.** Tell me *why* the change is better, not just *what* changed. I'll understand the reasoning even if I can't read the code.
- **Non-breaking.** Shelly is in daily use. Changes should not break existing functionality.

## Development setup

```bash
git clone https://github.com/RYOITABASHI/Shelly.git
cd Shelly
pnpm install
pnpm start
```

### Project structure

```
app/          → Expo Router pages (4 tabs: Chat, Projects, Terminal, Settings)
components/   → React Native components
lib/          → Core logic (input router, AI integrations, safety system)
store/        → Zustand stores
hooks/        → Custom React hooks
modules/      → Native modules (Termux Bridge)
```

## Code style

- TypeScript strict mode
- Functional components with hooks
- Zustand for state management
- NativeWind for styling

No linter or formatter is enforced yet. If you'd like to set one up, that would be a welcome contribution.

## Communication

- **Issues** for bugs and feature requests
- **Pull requests** for code changes
- **Discussions** for questions and ideas

I may not understand the technical details of every PR, but I will review the intent and impact of every contribution. For complex changes, a plain-language explanation in the PR description helps me follow along.

## License

By contributing, you agree that your contributions will be licensed under the [GNU General Public License v3.0](./LICENSE).
