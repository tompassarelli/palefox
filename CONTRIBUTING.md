# Contributing to Fennec

Thanks for your interest in contributing.

Fennec is a lean, CSS-first project. Contributions are welcome, but changes should preserve that scope and keep things simple.

## Good contributions

- Bug fixes
- Installation and compatibility fixes
- Documentation improvements
- Focused CSS refinements
- Firefox / LibreWolf compatibility improvements

## Before opening a larger PR

If the change is substantial or adds a new feature, please open an issue first. This helps avoid work on changes that don't fit the project's direction.

## Guidelines

- Keep PRs focused and small
- Preserve the modular structure under `chrome/fennec/` and `chrome/user/`
- Don't break update-safe customization (`chrome/user/` must survive reinstalls)
- Avoid unnecessary complexity
- Match existing naming and branding conventions

## Testing

When relevant, test on Firefox and LibreWolf. If installer behavior is affected, mention what you tested in the PR.

## Questions

If you're unsure whether something fits, open an issue and ask.
