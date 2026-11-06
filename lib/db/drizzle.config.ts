import { defineConfig } from "drizzle-kit";

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL, ensure the database is provisioned");
}

export default defineConfig({
  // Deliberately relative (not path.join(__dirname, ...)): drizzle-kit
  // treats this as a glob internally, and an absolute Windows path's
  // backslashes get misread as glob escape characters, matching zero files.
  schema: "./src/schema/index.ts",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL,
  },
});
