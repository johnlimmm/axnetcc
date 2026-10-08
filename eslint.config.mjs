import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    // Vinext emits static multi-page assets; plain anchors preserve full-page navigation.
    rules: {
      "@next/next/no-html-link-for-pages": "off",
      // site.css is emitted by the Vinext compatibility build and must be linked explicitly.
      "@next/next/no-css-tags": "off",
    },
  },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "dist/**",
    ".vinext/**",
    ".local-*/**",
    ".omx/**",
    ".wrangler/**",
    "outputs/**",
    "work/**",
    "deploy/**",
    "deploy-stage/**",
    "public/**/*.js",
    "public/**/*.map",
    "next-env.d.ts",
  ]),
]);

export default eslintConfig;
