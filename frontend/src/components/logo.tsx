// Gearbox logo: a gear (the factory machine) carrying radio waves (the air it runs on)
export function LogoMark({ className = "size-5" }: { className?: string }) {
  const teeth = Array.from({ length: 10 }, (_, i) => i * 36);
  return (
    <svg viewBox="0 0 64 64" className={className} aria-hidden="true">
      <g fill="currentColor">
        {teeth.map((a) => (
          <rect
            key={a}
            x="28"
            y="2"
            width="8"
            height="10"
            rx="1"
            transform={`rotate(${a} 32 32)`}
          />
        ))}
        <circle cx="32" cy="32" r="23" />
      </g>
      <circle cx="32" cy="32" r="17" fill="#1c1c1c" />
      <g fill="none" stroke="#e5e5e5" strokeWidth="3.2" strokeLinecap="round">
        <path d="M21.5 30.5a15 15 0 0 1 21 0" />
        <path d="M25.5 35a9 9 0 0 1 13 0" />
      </g>
      <circle cx="32" cy="40" r="2.8" fill="#e5e5e5" />
    </svg>
  );
}

export function Logo({ className = "" }: { className?: string }) {
  return (
    <span className={`flex items-center gap-2 ${className}`}>
      <LogoMark className="text-foreground size-5 dark:text-red-500" />
      <span className="text-sm leading-none font-semibold">Gearbox</span>
    </span>
  );
}
