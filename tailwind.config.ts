import type { Config } from "tailwindcss";

// Brand palette derived from Assets/ananta_logo_full.png (blue mark + grey wordmark).
const config: Config = {
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        ananta: {
          DEFAULT: "#3C6DA5",
          50: "#eef3f9",
          100: "#d6e2f0",
          200: "#aec6e1",
          300: "#85a9d1",
          400: "#5d8dc2",
          500: "#3C6DA5",
          600: "#315a89",
          700: "#27476c",
          800: "#1d3450",
          900: "#132234",
        },
        ink: {
          DEFAULT: "#4a4f55",
          muted: "#6b7178",
        },
      },
    },
  },
  plugins: [],
};

export default config;
