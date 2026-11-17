# UI v5 reference inspection

Inspected 2026-11-18, Asia/Taipei, with a real Chromium browser through the Playwright CLI named session `tech-refs`. Desktop viewport: 1440 × 1000 CSS px. Mobile viewport: 390 × 844 CSS px. Page screenshots are research evidence, not application assets. Values below came from `getComputedStyle`, page structure, actual hover/click interactions, and visual inspection. Proposed application tokens are separate in [design-tokens.md](../design-tokens.md).

## Primary sources and captures

| Official page | Capture | Coverage |
| --- | --- | --- |
| [Terax](https://terax.app/) | [Desktop](terax-desktop.png), [mobile](terax-mobile.png) | First viewport in the site's dark theme |
| [Terax](https://terax.app/) | [Editor section](terax-editor-desktop.png) | Scrolled desktop viewport showing actual editor screenshot and explanatory hierarchy |
| [InsForge](https://insforge.dev/) | [Desktop](insforge-desktop.png), [mobile](insforge-mobile.png) | First viewport in HUMAN mode |
| [InsForge](https://insforge.dev/) | [AGENT mode](insforge-agent-desktop.png) | Actual AGENT tab click; machine-readable Markdown presentation |

Captures were first generated under `output/playwright/tech-refs/`, then copied unchanged here. Both pages rendered successfully. The InsForge browser console reported nine CSP-blocked advertising/analytics requests; these did not prevent the captured content from rendering. No account, download, signup, or external message was triggered.

## Terax — observed

- The large canvas is a cool almost-black field with luminous diagonal streaks. The visual hero is spacious and centered; lower content pairs large actual application screenshots with concise editorial text. Numbered mono section labels and file-path bars supply the developer-tool character.
- Default UI/prose uses `Inter, "Inter Fallback"`. Metadata, release badge, and path captions use `"Geist Mono", "Geist Mono Fallback"`. Desktop H1 is 72px / 72px, weight 600; first hero prose is 18px / 28px, weight 400. Mobile H1 is 36px / 40px. Navigation text is 14px / 20px. Small metadata is 11px / 16.5px.
- Computed CSS uses Lab values. The table includes browser canvas conversion to 8-bit sRGB for convenient comparison; the Lab column is the actual CSS value, and the hex column is rounded conversion rather than a source hex declaration.

| Role | Exact observed CSS | Converted sRGB |
| --- | --- | --- |
| Background | `lab(2.93655% -.435196 -.608262)` | `#090b0c` |
| Foreground | `lab(98.5129% -.644743 -.229931)` | `#f9fbfb` |
| Card | `lab(9.32863% -1.87989 -2.1017)` | `#161b1d` |
| Muted foreground | `lab(67.9697% -3.85058 -3.02824)` | `#9ca8ab` |
| Primary button fill | `lab(91.3368% -1.38441 -1.08377)` | `#e3e7e8` |
| Default border | `lab(100% 0 0/.1)` | white at 10% opacity |

- Secondary hero CTA starts transparent with a 1px white/10 border. Actual hover changes its fill to white at 4.5% opacity; text and border remain stable. Its computed transform is `none`, box shadow `none`, and transition duration 150ms with `cubic-bezier(.4,0,.2,1)`. Header transition is 300ms.
- The headline text changes between snapshots in a typewriter-like sequence. `document.getAnimations()` returned an empty list at one sample, so that is not evidence that the site has no motion: JavaScript-driven text changes are still visible. The streaks' precise rendering or motion implementation was not determined.
- The editor/code example is an `<img>` (`editor.webp`), framed by a filename strip and window dots. It is not live HTML syntax highlighting. Its screenshot visibly separates a narrow file tree, tab row, line numbers, and muted syntax colors. Those pixels do not establish reusable CSS syntax tokens.
- Mobile inspection returned document scroll width 390 for viewport width 390. The desktop navigation compresses and the hero text scales down. This finding covers the sampled page state only.

## InsForge — observed

- The first viewport is structured by a faint rectilinear grid, a centered two-line headline, thin gray boundaries, and generous black space. Mint appears on the headline's first line, active view toggle, and signup control. The next section is separated by one full-width hairline, not multiple floating cards.
- The body default is Inter, but the actual hero H1 and hero prose are **Manrope**. Desktop H1 is 48px / 56.16px, weight 400; mobile H1 is 32px / 37.44px. Hero prose is 16px / 24px, weight 400. The hero docs CTA uses Inter 18px / 32px, weight 500. A body-level font read alone would therefore misidentify the site's main display typography.

| Role | Exact observed computed value | Hex equivalent |
| --- | --- | --- |
| Body background | `rgb(10, 10, 10)` | `#0a0a0a` |
| Navigation / hero docs CTA background | `rgb(0, 0, 0)` | `#000000` |
| Foreground | `rgb(255, 255, 255)` | `#ffffff` |
| Hero muted prose | `rgb(163, 163, 163)` | `#a3a3a3` |
| Mint headline / signup fill | `rgb(110, 231, 183)` | `#6ee7b7` |
| Repeated separator/border color | `rgb(51, 51, 51)` | `#333333` |
| Repeated low-opacity fills/borders | white at 4% and 8% | `rgba(255,255,255,.04/.08)` |

- Hero docs CTA has a 1px white border and 4px corner radius. Signup also has a 4px corner radius. Actual signup hover did not change the sampled computed mint fill, transform (`none`), or shadow (`none`). It should not be described as a glowing or lifting hover.
- Browser animation inspection found a running logo marquee with a 90,000ms linear infinite cycle and sampled 400ms entrance effects using `cubic-bezier(.22,1,.36,1)`. The first viewport visibly contains horizontally arranged tool logos; their assets and layout should not be copied into this application.
- Clicking AGENT replaces the visual landing with a single readable Markdown-style code surface, including mint punctuation, white headings, and subdued front matter. The observed `<pre>` family is `ui-monospace, "SF Mono", Menlo, Consolas, monospace`, with `rgb(180,180,180)` base text. This supports a restrained text/code presentation rather than dense decorative syntax colors.
- Mobile inspection returned document scroll width 390 for viewport width 390. The CTA pair stacks vertically and headline wraps into three lines; the grid continues behind the content. The persistent mode toggle is visible near the bottom.

## Translation into our own interface

Use Terax's clear filename bars, serial section labels, real code context, and quiet hierarchy. Use InsForge's dark grid structure, small mint accents, rectangular controls, and disciplined divider lines. The resulting application should emphasize its own React Flow relationships, L0–L4 selection, file tree, source excerpt, and evidence details. The target palette deliberately introduces navy surfaces and a blue source accent; these are project proposals, not claims about either reference site.

Keep the reference screenshots only in this documentation directory. Do not import their logos, marketing copy, mascot, product screenshots, background art, or layout wholesale into the application. Do not reproduce a landing-page hero where the user needs a working diagram.

## Font provenance

Checked against the font owners' sources on 2026-11-18:

- **Inter:** [official family page](https://rsms.me/inter/), [official repository](https://github.com/rsms/inter), [official license](https://github.com/rsms/inter/blob/master/LICENSE.txt). The license identifies the Inter Project Authors and SIL Open Font License 1.1.
- **Geist Mono:** [Vercel font page](https://vercel.com/font), [official repository](https://github.com/vercel/geist-font), [official license text](https://raw.githubusercontent.com/vercel/geist-font/main/LICENSE.txt). The license identifies Vercel in collaboration with basement.studio and SIL Open Font License 1.1. The attempted repository path ending `/LICENSE` returned 404; `/LICENSE.txt` is the verified source.

For self-hosted distribution, retain the actual package's copyright and license files with its font files. These sources establish provenance for selecting the fonts; package/version selection and app installation remain implementation work. This research did not download or modify application font assets.
