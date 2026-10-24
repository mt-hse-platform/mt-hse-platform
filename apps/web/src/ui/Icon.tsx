const PATHS: Record<string, string> = {
  home: 'M3 11l9-8 9 8v9a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z',
  settings: 'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8zm8.5 4l1.7-1.3-1.8-3.1-2 .7a7 7 0 0 0-1.6-.9L16.5 5h-3.6l-.3 2.4a7 7 0 0 0-1.6.9l-2-.7L7.2 10.7 9 12l-1.7 1.3 1.8 3.1 2-.7c.5.4 1 .7 1.6.9l.3 2.4h3.6l.3-2.4c.6-.2 1.1-.5 1.6-.9l2 .7 1.8-3.1z',
  plus: 'M11 4h2v7h7v2h-7v7h-2v-7H4v-2h7z',
  bell: 'M12 2a6 6 0 0 0-6 6v3.6L4 15v1h16v-1l-2-3.4V8a6 6 0 0 0-6-6zm0 20a2.5 2.5 0 0 0 2.5-2.5h-5A2.5 2.5 0 0 0 12 22z',
  notifications: 'M12 2a6 6 0 0 0-6 6v3.6L4 15v1h16v-1l-2-3.4V8a6 6 0 0 0-6-6zm0 20a2.5 2.5 0 0 0 2.5-2.5h-5A2.5 2.5 0 0 0 12 22z',
  more: 'M5 10.5a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3zm7 0a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3zm7 0a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3z',
  dot: 'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8z',
};

export function Icon({ name, size = 22 }: { name: string; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" focusable="false">
      <path d={PATHS[name] ?? PATHS.dot} />
    </svg>
  );
}
