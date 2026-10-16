# Contributing to Portsviews

Thanks for wanting to help. This is a small project, it is maintained by one
person, and every bug report or idea genuinely helps.

## Ways to help

- **Report a bug.** Open an issue with the area you were watching (`dover`,
  `istanbul`, `portsaid`, `sydney`, or a local area of your own), what was on
  screen, and the text from the browser console. That is usually enough to track
  it down.
- **Suggest an idea.** Say what you would like to see. You do not need to write
  any code for this.
- **Write code.** Fixes, new ship shapes, better labels — anything focused.
- **Improve the docs.** If a step in the README tripped you up, it will trip up
  the next person too.
- **Make a map for another area.** Only Dover ships with a coastline today. A
  new Protomaps extract plus a row in `shared/src/basemap.ts` gives another
  coast a real map.

## How to run it

The README's **Quick start** section gets the server and the display running in
about ten minutes, and its **Your own area** section covers custom areas and
their maps. Follow those two first.

## How to run the checks

Before opening a pull request, these must pass:

```bash
pnpm --filter display tsc --noEmit
pnpm --filter @wake/server tsc --noEmit
```

Tests are plain TypeScript files run with `tsx`, with no test framework. Run all
of them.

PowerShell:

```powershell
git ls-files "*.test.ts" | ForEach-Object { npx tsx $_ }
```

bash:

```bash
for f in $(git ls-files '*.test.ts'); do npx tsx "$f" || exit 1; done
```

Each file prints its own summary and exits with a non-zero status if anything
failed.

## Ground rules

- Keep pull requests small and focused: one thing each.
- Add or update a test alongside your change.
- Never commit `.env`, `areas.local.json`, map files, or anything containing a
  key. They are already ignored by git, so this mostly means do not force-add
  them.
- Say what you did and what you did not test.
- The code is MIT licensed (see [LICENSE](LICENSE)), and contributions come in
  under the same licence.
- This is maintained by one person, so a reply can take a few days. Be kind.
