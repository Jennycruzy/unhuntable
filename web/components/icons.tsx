import type { ReactNode } from "react";

/** One stroke weight, one grid (24), currentColor. Decorative unless a label is given. */
function Icon({ children, label }: { children: ReactNode; label?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden={label ? undefined : true} role={label ? "img" : undefined} aria-label={label}>
      {children}
    </svg>
  );
}

/** The mark: a ring broken into five pieces that never touch. */
export function Mark() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" aria-hidden>
      <path d="M12 3.2a8.8 8.8 0 0 1 6.9 3.3" />
      <path d="M20.6 10.4a8.8 8.8 0 0 1-1.4 6.6" />
      <path d="M16.6 19.5a8.8 8.8 0 0 1-6.7 1.1" />
      <path d="M6.7 19a8.8 8.8 0 0 1-3.4-5.9" />
      <path d="M3.6 9a8.8 8.8 0 0 1 4.8-5" />
    </svg>
  );
}

export const IconStart = () => (
  <Icon>
    <path d="M4 10.5 12 4l8 6.5V20H4z" />
    <path d="M9.5 20v-5.5h5V20" />
  </Icon>
);

export const IconDeposit = () => (
  <Icon>
    <path d="M12 4v11" />
    <path d="m7.5 10.5 4.5 4.5 4.5-4.5" />
    <path d="M5 19.5h14" />
  </Icon>
);

export const IconTrade = () => (
  <Icon>
    <path d="m4 16 5-5 4 3 7-7" />
    <path d="M15 7h5v5" />
  </Icon>
);

export const IconPositions = () => (
  <Icon>
    <rect x="4" y="4" width="6.5" height="6.5" rx="1.5" />
    <rect x="13.5" y="4" width="6.5" height="6.5" rx="1.5" />
    <rect x="4" y="13.5" width="6.5" height="6.5" rx="1.5" />
    <rect x="13.5" y="13.5" width="6.5" height="6.5" rx="1.5" />
  </Icon>
);

export const IconHome = () => (
  <Icon>
    <path d="M20 12a8 8 0 1 1-2.3-5.7" />
    <path d="M20 4.5V9h-4.5" />
  </Icon>
);
