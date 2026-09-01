import { defineConfig, globalIgnores } from "eslint/config";
import js from "@eslint/js";
import globals from "globals";

const eslintConfig = defineConfig([
  js.configs.recommended,
  {
    files: ["**/*.js"],
    languageOptions: {
      globals: globals.node,
      ecmaVersion: "latest",
      sourceType: "commonjs",
    },
    rules: {
      "no-unused-vars": ["error", { "argsIgnorePattern": "^_" }],
    },
  },
  globalIgnores([
    "node_modules/**",
    "*.sqlite",
    "*.sqlite-wal",
    "*.sqlite-shm",
    "next-env.d.ts",
  ]),
]);

export default eslintConfig;
