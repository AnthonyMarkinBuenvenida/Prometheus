# Design system

Layered and restrained. Depth comes from stacked surfaces and hairline borders, not from glow or gradients. One accent — honey/gold — used sparingly in every theme.

## Tokens (`src/styles/tokens.css`)

| Group | Tokens | Use |
|---|---|---|
| Surfaces | `--bg-app` < `--bg-sidebar` < `--bg-surface` < `--bg-elevated` | Canvas → side panels → cards/composer → popovers/menus |
| Overlays | `--bg-hover`, `--bg-active`, `--bg-selected` | Translucent washes for interaction states |
| Borders | `--border-subtle`, `--border`, `--border-strong` | Dividers → controls → hover/emphasis |
| Text | `--text-primary`, `--text-secondary`, `--text-tertiary` | Content → labels/meta → hints/placeholders |
| Accent | `--accent`, `--accent-soft`, `--accent-text` | Logo, active toggles, focus ring, thinking indicators. Not for large fills. |
| Status | `--danger*`, `--success*` | Errors, destructive actions, connection status |
| Components | `--bg-elevated-hover`, `--bg-tooltip`/`--fg-tooltip`, `--bg-toast`, `--control-track`, `--switch-thumb*`, `--slider-thumb*`, `--send-disabled-bg`, `--accent-border`/`-focus`/`-ring`, `--logo-*`, … | Every former hard-coded color; components must not use literal colors |
| Syntax | `--hl-*`, `--code-inline-bg`, `--code-head-bg`, `--table-head-bg` | Code and table rendering per theme |
| Spacing | `--sp-1`…`--sp-10` | 4px grid |
| Radius | `--r-xs`…`--r-2xl`, `--r-full` | Controls 6–8, cards 12, composer 22 |
| Motion | `--dur-fast` 120ms, `--dur` 200ms, `--dur-slow` 280ms, `--ease` | Reduced-motion users get near-zero durations (global.css) |

## Themes

`data-theme` on `<html>`: **`dark`** (default, charcoal), **`black`** (true black for OLED; overrides only surfaces/borders of dark), **`light`** (White + Gold: white canvas, warm-gray `#f6f4ef` sidebar, charcoal `#1c1b19` text and primary buttons, gold `#b8860b` fills and `#7d5a0c` gold text — gold stays an accent). `public/theme-init.js` applies the saved theme before first paint (an external file because the CSP forbids inline scripts); keep its list in sync with `THEMES`/`THEME_COLOR` in `src/lib/settingsModel.ts`.

Adding a theme: define **every** token the dark block defines, add it to `THEMES`/`THEME_COLOR`, and run `npm test` — `src/styles/tokens.test.ts` fails on a missing token or any text/surface, syntax/code, button or tooltip pair below 4.5:1. Then check axe and screenshots in the browser.

Text size and chat width use `data-font-size` / `data-chat-width`.

## Layering

Two systems, used deliberately:

1. **In-page stacking** (`z-index` tokens, nothing ad hoc): `--z-drawer` 40 (off-canvas sidebar/panel; backdrop is one below) → `--z-popover` 50 (menus, portaled to `<body>`) → `--z-tooltip` 70.
2. **Browser top layer** (always above any `z-index`): modal `<dialog>`s (Settings, confirmations) and the toast region (`popover="manual"`). Top-layer order is insertion order: a confirm opened from Settings sits above it; the toast region is re-shown on every new toast so it stays above dialogs opened earlier.

While a modal dialog is open, everything outside it is inert by design — toasts stay visible (and announce via a separate always-mounted live region) but their dismiss button isn't clickable until the dialog closes; they auto-dismiss.

## Layout

| Width | Sidebar | Generation panel |
|---|---|---|
| ≥ 1280 | Inline (or 60px rail when collapsed) | Inline column |
| 1024–1279 | Inline / rail | Overlay drawer |
| < 1024 | Off-canvas drawer + backdrop | Overlay drawer |

Message column max width is `--content-w` (768, or 960 when "Wide"). Use `100dvh`, respect `env(safe-area-inset-*)`, and never allow page-level horizontal scroll: wide content (code, tables) scrolls inside its own container.

## Component conventions

- **Buttons**: `.btn` + `.btn-primary | -secondary | -ghost | -danger`, `.btn-sm`. Icon-only: `.icon-btn` (+ `.icon-btn-sm`) with `aria-label` and usually `data-tooltip`.
- **Tooltips**: CSS-only via `data-tooltip`, `data-tooltip-side="top|right"`, `data-tooltip-align="end"`. Hover-capable devices only; the `aria-label` carries the meaning.
- **Focus**: `:focus-visible` gets `--focus-ring`. Don't remove it; inputs inside a styled container may replace it with a container `:focus-within` treatment.
- **Menus/popovers**: `Popover` (portal, fixed, flips upward) + `menuKeyDown` for arrow/Home/End. Items use `role="menuitem"` / `"menuitemradio"`.
- **Dialogs**: native `<dialog>` via `Dialog`; confirmations via `useConfirm()`. Destructive confirms use `danger`.
- **Disabled controls** explain why (tooltip, `disabledReason`, or adjacent text). If a capability doesn't exist, show it as unavailable — don't fake it.
- **Empty / loading / error**: every data view has all three. Errors are inline next to where the action happened, with a retry when one makes sense.
- **Dialog initial focus**: mark the element with `data-autofocus` (React's `autoFocus` runs before `showModal()`). Destructive confirmations focus Cancel.
- **Long waits are explained**: while waiting for the first token the message shows elapsed seconds and, after 12 s, a note that the model is busy. A response stopped by the host time limit shows "Paused at the time limit" (accent, not error styling) with Continue.
- **Fallbacks are visible, never silent**: the user picks the model. Only with *Fall back if my chosen model fails* on can another model answer; that reply shows the model that answered plus a small provider chip with a "fallback" flag whose one-sentence reason (and, with *Show routing details*, the full decision) opens on click. When a model fails before answering (only reasoning shown), the reply is cleared and the waiting row says *"The model is busy. Trying another available model…"* until the next model starts — the user never sees two models in one reply.
- **Token presets** only show values the active model supports (`maxOutput` from `/api/models`); the slider steps by 1,000 up to the model's maximum (the app cap is 300,000).

## Rendering model output

`Markdown` → `normalizeMath` (delimiters → `$$`, code untouched, unclosed math hidden while streaming) → `splitBlocks` (memoized top-level blocks; only the growing block re-parses) → react-markdown + GFM, plus remark-math/rehype-katex and lowlight, both lazy chunks preloaded when a response starts. Code blocks: language label, Wrap toggle, Copy (raw text), unknown languages plain. A render failure falls back to the raw text for that message only (`ErrorBoundary`).
