// Inline stroke icons (24px grid, 1.75 stroke). Kept in one place to avoid an icon dependency.

const PATHS = {
  menu: <path d="M4 7h16M4 12h16M4 17h16" />,
  plus: <path d="M12 5v14M5 12h14" />,
  compose: (
    <>
      <path d="M12 4H6.5A2.5 2.5 0 0 0 4 6.5v11A2.5 2.5 0 0 0 6.5 20h11a2.5 2.5 0 0 0 2.5-2.5V12" />
      <path d="M17.6 3.6a1.9 1.9 0 0 1 2.8 2.8L12.5 14.3 9 15l.7-3.5z" />
    </>
  ),
  search: (
    <>
      <circle cx="11" cy="11" r="6.5" />
      <path d="m20 20-4.2-4.2" />
    </>
  ),
  settings: (
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M12 2.8v2.4M12 18.8v2.4M2.8 12h2.4M18.8 12h2.4M5.5 5.5l1.7 1.7M16.8 16.8l1.7 1.7M5.5 18.5l1.7-1.7M16.8 7.2l1.7-1.7" />
      <circle cx="12" cy="12" r="6.6" />
    </>
  ),
  sliders: (
    <>
      <path d="M4 7h9M17 7h3M4 12h3M11 12h9M4 17h11M19 17h1" />
      <circle cx="15" cy="7" r="2" />
      <circle cx="9" cy="12" r="2" />
      <circle cx="17" cy="17" r="2" />
    </>
  ),
  sidebar: (
    <>
      <rect x="3.5" y="4.5" width="17" height="15" rx="2.5" />
      <path d="M9.5 4.5v15" />
    </>
  ),
  chevronDown: <path d="m6.5 9.5 5.5 5.5 5.5-5.5" />,
  chevronRight: <path d="m9.5 6.5 5.5 5.5-5.5 5.5" />,
  check: <path d="m5 12.5 4.5 4.5L19 7.5" />,
  copy: (
    <>
      <rect x="9" y="9" width="11" height="11" rx="2.5" />
      <path d="M15 9V6.5A2.5 2.5 0 0 0 12.5 4h-6A2.5 2.5 0 0 0 4 6.5v6A2.5 2.5 0 0 0 6.5 15H9" />
    </>
  ),
  refresh: (
    <>
      <path d="M19.5 12a7.5 7.5 0 1 1-2.2-5.3" />
      <path d="M19.5 4.5v4h-4" />
    </>
  ),
  pencil: <path d="M4 20h4L18.6 9.4a2.8 2.8 0 0 0-4-4L4 16z" />,
  trash: <path d="M4.5 7h15M10 11v5.5M14 11v5.5M6.5 7l.8 11.2A2 2 0 0 0 9.3 20h5.4a2 2 0 0 0 2-1.8L17.5 7M9.5 7V4.8a.8.8 0 0 1 .8-.8h3.4a.8.8 0 0 1 .8.8V7" />,
  more: (
    <>
      <circle cx="5.5" cy="12" r="1.3" fill="currentColor" />
      <circle cx="12" cy="12" r="1.3" fill="currentColor" />
      <circle cx="18.5" cy="12" r="1.3" fill="currentColor" />
    </>
  ),
  x: <path d="M6.5 6.5l11 11M17.5 6.5l-11 11" />,
  paperclip: <path d="m19.5 11.3-7.6 7.6a4.8 4.8 0 0 1-6.8-6.8l8-8a3.2 3.2 0 0 1 4.5 4.5l-8 8a1.6 1.6 0 0 1-2.3-2.3l7.3-7.3" />,
  arrowUp: <path d="M12 19V5.5M6 11.5l6-6 6 6" />,
  arrowDown: <path d="M12 5v13.5M6 12.5l6 6 6-6" />,
  stop: <rect x="7" y="7" width="10" height="10" rx="2" fill="currentColor" stroke="none" />,
  spark: <path d="M12 3.5c.4 3.9 2.6 6.1 6.5 6.5-3.9.4-6.1 2.6-6.5 6.5-.4-3.9-2.6-6.1-6.5-6.5 3.9-.4 6.1-2.6 6.5-6.5zM18.5 15.5c.2 1.6 1 2.4 2.5 2.5-1.5.2-2.3 1-2.5 2.5-.2-1.5-1-2.3-2.5-2.5 1.5-.1 2.3-.9 2.5-2.5z" />,
  file: (
    <>
      <path d="M13.5 3.5H7A2.5 2.5 0 0 0 4.5 6v12A2.5 2.5 0 0 0 7 20.5h10a2.5 2.5 0 0 0 2.5-2.5V9.5z" />
      <path d="M13.5 3.5v6h6" />
    </>
  ),
  download: <path d="M12 4v11M7 10.5l5 5 5-5M5 20h14" />,
  alert: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 7.8v5M12 16.2v.1" />
    </>
  ),
  info: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 11v5M12 7.8v.1" />
    </>
  ),
  chat: <path d="M20 11.5a7.5 7.5 0 0 1-10.9 6.7L4.5 19.5l1.3-4.2A7.5 7.5 0 1 1 20 11.5z" />,
  keyboard: (
    <>
      <rect x="3" y="6" width="18" height="12" rx="2.5" />
      <path d="M7 10h.01M11 10h.01M15 10h.01M17 14H7" />
    </>
  ),
  palette: (
    <>
      <path d="M12 3.5a8.5 8.5 0 1 0 0 17c1 0 1.6-.8 1.6-1.6 0-.5-.2-.8-.4-1.1-.3-.3-.4-.7-.4-1.1 0-.9.7-1.6 1.6-1.6h1.9a4.2 4.2 0 0 0 4.2-4.2C20.5 6.9 16.7 3.5 12 3.5z" />
      <circle cx="7.8" cy="11.5" r="1" fill="currentColor" />
      <circle cx="10.5" cy="7.8" r="1" fill="currentColor" />
      <circle cx="15" cy="8.2" r="1" fill="currentColor" />
    </>
  ),
  database: (
    <>
      <ellipse cx="12" cy="6" rx="7.5" ry="2.5" />
      <path d="M4.5 6v6c0 1.4 3.4 2.5 7.5 2.5s7.5-1.1 7.5-2.5V6M4.5 12v6c0 1.4 3.4 2.5 7.5 2.5s7.5-1.1 7.5-2.5v-6" />
    </>
  ),
  bolt: <path d="M13 3.5 5.5 13.5H12l-1 7 7.5-10H12z" />,
  wrap: <path d="M4 6.5h16M4 12h13a3 3 0 0 1 0 6h-4m0 0 2-2m-2 2 2 2M4 17.5h5" />,
  briefcase: (
    <>
      <rect x="3.5" y="7.5" width="17" height="12" rx="2.5" />
      <path d="M9 7.5V6a1.5 1.5 0 0 1 1.5-1.5h3A1.5 1.5 0 0 1 15 6v1.5M3.5 12.5h17" />
    </>
  ),
  cap: (
    <>
      <path d="M2.5 9.5 12 5l9.5 4.5L12 14z" />
      <path d="M6.5 11.6v3.9c1.5 1.5 3.5 2.2 5.5 2.2s4-.7 5.5-2.2v-3.9M21.5 9.5v5" />
    </>
  ),
  target: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <circle cx="12" cy="12" r="4.5" />
      <circle cx="12" cy="12" r="0.8" fill="currentColor" />
    </>
  ),
  external: <path d="M14 4.5h5.5V10M19.5 4.5 11 13M17.5 13.5V18a1.5 1.5 0 0 1-1.5 1.5H6A1.5 1.5 0 0 1 4.5 18V8A1.5 1.5 0 0 1 6 6.5h4.5" />,

} as const;

export type IconName = keyof typeof PATHS;

export function Icon({ name, size = 18, className }: { name: IconName; size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      className={className}
    >
      {PATHS[name]}
    </svg>
  );
}

export function Logo({ size = 28 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true" focusable="false">
      {/* Colors come from theme tokens (CSS variables only work via style, not SVG attributes). */}
      <rect width="32" height="32" rx="9" style={{ fill: "var(--logo-bg)" }} />
      <rect x="0.5" y="0.5" width="31" height="31" rx="8.5" fill="none" style={{ stroke: "var(--logo-border)" }} />
      {/* Prometheus "Flame": the gift of fire. The inner cut is drawn in the tile color, so one accent works in every theme. */}
      <path d="M16 5.2c3.1 3.2 7 7.4 7 12.6 0 4.6-3.1 8-7 8s-7-3.4-7-8c0-3.6 2.2-6.1 3.6-7.5.1 2.3 1 3.9 2.3 4.6-.3-3.7.3-6.9 1.1-9.7z" style={{ fill: "var(--logo-mark)" }} />
      <path d="M16 24.6c-1.9 0-3.2-1.5-3.2-3.3 0-2 1.6-3.3 2.6-4.8.3 1.6 1.2 2.5 2.2 2.8 1 .4 1.6 1.3 1.6 2.3 0 1.7-1.4 3-3.2 3z" style={{ fill: "var(--logo-bg)" }} />
    </svg>
  );
}
