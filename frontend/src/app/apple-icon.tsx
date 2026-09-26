import { ImageResponse } from "next/og";

export const size = { width: 180, height: 180 };
export const contentType = "image/png";

// Home-screen icon: the Gearbox mark on a dark tile (same drawing as icon.svg)
export default function AppleIcon() {
  const teeth = Array.from({ length: 10 }, (_, i) => i * 36);
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          background: "#171717",
        }}
      >
        <svg width="180" height="180" viewBox="0 0 64 64">
          <g fill="#f5f5f5">
            {teeth.map((a) => (
              <rect
                key={a}
                x="28"
                y="4"
                width="8"
                height="9"
                rx="1.5"
                transform={`rotate(${a} 32 32)`}
              />
            ))}
            <circle cx="32" cy="32" r="21" />
          </g>
          <circle cx="32" cy="32" r="15.5" fill="#171717" />
          <g
            fill="none"
            stroke="#f5f5f5"
            strokeWidth="3"
            strokeLinecap="round"
          >
            <path d="M22.5 30.8a13.5 13.5 0 0 1 19 0" />
            <path d="M26.2 34.8a8.2 8.2 0 0 1 11.6 0" />
          </g>
          <circle cx="32" cy="39.8" r="2.7" fill="#E31937" />
        </svg>
      </div>
    ),
    size,
  );
}
