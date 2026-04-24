import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./index.html", "./src/**/*.{js,ts,jsx,tsx}", "./lib/**/*.{js,ts,jsx,tsx}"],
  theme: {
    extend: {
      colors: {
        ink: "#1f2a2e",
        paper: "#f7f4ee",
        mint: "#d9f2e6",
        coral: "#ff7a59",
        steel: "#52616b",
        line: "#ded9cf"
      },
      boxShadow: {
        soft: "0 16px 42px rgba(31, 42, 46, 0.12)"
      }
    }
  },
  plugins: []
};

export default config;
