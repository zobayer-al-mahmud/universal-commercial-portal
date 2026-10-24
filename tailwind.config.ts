import type { Config } from "tailwindcss";

// Brand palette derived from public/ananta_logo_full.png:
// a woven blue fabric swatch (#3C6DA5) with a grey wordmark on white.
const config: Config = {
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        ananta: {
          DEFAULT: "#3C6DA5",
          50: "#eff4fa",
          100: "#d9e5f3",
          200: "#b4cae6",
          300: "#86a9d4",
          400: "#5d8dc2",
          500: "#3C6DA5",
          600: "#315a89",
          700: "#27476c",
          800: "#1d3450",
          900: "#152638",
        },
        ink: {
          DEFAULT: "#2b3139",
          muted: "#5b6572",
          faint: "#8a93a1",
        },
        surface: {
          DEFAULT: "#ffffff",
          muted: "#f6f8fb",
          sunken: "#eef2f7",
        },
      },
      borderRadius: {
        xl: "0.75rem",
        "2xl": "1rem",
      },
      boxShadow: {
        card: "0 1px 2px 0 rgb(16 24 40 / 0.04), 0 1px 3px 0 rgb(16 24 40 / 0.06)",
        "card-hover": "0 4px 12px -2px rgb(16 24 40 / 0.10), 0 2px 6px -2px rgb(16 24 40 / 0.06)",
        pop: "0 10px 30px -8px rgb(16 24 40 / 0.18)",
      },
      keyframes: {
        shimmer: {
          "100%": { transform: "translateX(100%)" },
        },
        "fade-in": {
          from: { opacity: "0", transform: "translateY(4px)" },
          to: { opacity: "1", transform: "translateY(0)" },
        },
      },
      animation: {
        shimmer: "shimmer 1.4s infinite",
        "fade-in": "fade-in 0.2s ease-out",
      },
    },
  },
  plugins: [],
};

export default config;
