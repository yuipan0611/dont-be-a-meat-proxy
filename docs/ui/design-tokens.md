# UI v5 — dark technical workspace tokens

Target specification for the UI v5 implementation, 2026-11-18. **These are proposed application values, not a claim that existing CSS already uses every token.** Real reference observations and screenshots are recorded in [reference/research-notes.md](reference/research-notes.md). The palette uses the observed InsForge mint `#6ee7b7` with original navy structure and readable neutral text.

## Color

| Semantic role | Proposed value | Intended use |
| --- | --- | --- |
| `--canvas` | `#080c12` | Main dark canvas, source viewer base |
| `--surface` | `#0e141d` | Navigation rail, nodes, details panels |
| `--text` | `#edf4f8` | Titles, labels, source base text |
| `--text-muted` | `#a4b3c3` | Descriptions, breadcrumbs, file metadata |
| `--accent` | `#6ee7b7` | Selected path, active node, primary action, focus |
| `--source-accent` | `#8bbdff` | Source links and code token emphasis |
| `--comment` | `#8294a7` | Readable source comments and secondary line annotations |
| `--border` | `#334454` | Decorative panel separators and inactive structural outlines |
| `--control-border` | `#62758a` | Boundaries needed to identify an unfilled control |
| `--warning` | `#efb875` | Warning icon and explicit warning text |
| `--danger` | `#f28c9b` | Error icon and explicit failure text |

Mint is a selection and action cue, blue indicates source/code context, amber and rose indicate explicit status. Pair status colors with text or icons. Keep canvas grids and panel separators subdued; use the stronger boundary or mint whenever the outline itself is necessary to identify a control or its selected state. A decorative border does not qualify as the only visible focus indicator.

## Calculated contrast

Calculated from the opaque sRGB hex values above with WCAG relative luminance: each channel is linearized at 0.04045, luminance is `0.2126R + 0.7152G + 0.0722B`, ratio is `(lighter + .05) / (darker + .05)`. Values below are rounded for display; threshold decisions use unrounded values. These are **calculated palette pairs**, not browser audit results or a statement of full WCAG conformance. Transparency, disabled styling, overlays, and actual component states require final rendered checks.

| Foreground / background | Ratio | Intended result |
| --- | ---: | --- |
| Text `#edf4f8` / canvas `#080c12` | 17.63:1 | Normal text passes AA |
| Text `#edf4f8` / surface `#0e141d` | 16.63:1 | Normal text passes AA |
| Muted `#a4b3c3` / canvas `#080c12` | 9.16:1 | Normal text passes AA |
| Muted `#a4b3c3` / surface `#0e141d` | 8.64:1 | Normal text passes AA |
| Mint `#6ee7b7` / canvas `#080c12` | 12.86:1 | Text and meaningful marks pass AA contrast thresholds |
| Mint `#6ee7b7` / surface `#0e141d` | 12.12:1 | Text, focus, selected boundary |
| Blue `#8bbdff` / canvas `#080c12` | 10.10:1 | Source link text |
| Blue `#8bbdff` / surface `#0e141d` | 9.52:1 | Source link and code token text |
| Canvas `#080c12` / mint `#6ee7b7` | 12.86:1 | Filled primary button text |
| Comment `#8294a7` / surface `#0e141d` | 5.93:1 | Normal source comment text passes AA |
| Control border `#62758a` / surface `#0e141d` | 3.90:1 | Meaningful boundary passes 3:1 |
| Decorative border `#334454` / surface `#0e141d` | 1.84:1 | Decoration only; insufficient as sole meaningful boundary |
| Warning `#efb875` / surface `#0e141d` | 10.37:1 | Normal text passes AA |
| Danger `#f28c9b` / surface `#0e141d` | 7.92:1 | Normal text passes AA |

The reference thresholds are [W3C text contrast minimum](https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html) (4.5:1 for normal text; 3:1 for qualifying large text) and [W3C non-text contrast](https://www.w3.org/WAI/WCAG22/Understanding/non-text-contrast.html) (3:1 for meaningful UI component/state information).

## Typography

| Role | Proposed family and size | Rules |
| --- | --- | --- |
| UI and Traditional Chinese prose | `Inter, "Noto Sans TC", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif` | Readable Chinese fallback; regular 400, medium 500, strong 600 |
| Technical labels, paths, source | `"Geist Mono", "SFMono-Regular", Consolas, monospace` | 12–13px / 1.6 for source; 11–12px for secondary serial labels |
| App title | 20–24px / 1.2, weight 600 | Compact workspace hierarchy, not a marketing hero |
| Diagram node title | 14–16px / 1.4, weight 600 | Short, stable width; wrap long Chinese labels |
| Supporting prose | 13–14px / 1.6 | Keep key actions and source context readable |
| Mobile controls | 14px or larger; 44px target height | Let labels wrap; avoid horizontal viewport overflow |

Inter and Geist Mono have verified official SIL OFL 1.1 sources linked in the [font provenance notes](reference/research-notes.md#font-provenance). Noto Sans TC is a proposed fallback family name, not a verified installed or downloaded font in this research. Do not imply that Latin-only font files cover Traditional Chinese.

## Structure, states, and motion

- Use the same semantic colors across the diagram, file tree, breadcrumb, and source viewer so selection reads as one continuous path. Give the current L0–L4 level a text label and a persistent active marker.
- Frame source with a filename bar, language label, line numbers, and clear excerpt boundaries. Use horizontal scrolling inside the source pane when needed; do not widen the page. Keep comments legible instead of using nearly invisible gray.
- Default controls use 4–8px radii; reserve pill styling for small tags, not every surface. Use 1px structural borders and a visible 2px focus outline with spacing from the component edge.
- Suggested spacing scale: 4, 8, 12, 16, 24, 32px. Give the diagram the largest uninterrupted area, and distinguish structural regions through alignment, dividers, and surface changes.
- Hover/focus color transitions: 150ms `cubic-bezier(.4,0,.2,1)`. Panel/excerpt appearance: 180–240ms opacity or small positional transition. These motion values are proposals; Terax's sampled 150ms color change is the reference anchor. Avoid continuous decorative motion in a working graph.
- Honor `prefers-reduced-motion: reduce`: remove positional animation and animated paths; keep immediate visual selection/focus changes. Preserve keyboard access and visible focus in all views.

## Visual acceptance intent

The desktop should feel like an open technical workspace: black/navy canvas, a narrow structured rail, clear diagram connections, quiet source context, mint selection, and blue source emphasis. The mobile view should keep the current level, selected item, and next action visible with touch-sized controls, while the graph and code panes manage their own overflow. Reference images remain documentation evidence only.
