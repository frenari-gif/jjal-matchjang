const fs = require("fs");
const path = require("path");

const envPath = path.join(process.cwd(), ".env");
const schemaDir = path.join(process.cwd(), "prisma");

function readDatabaseUrl() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  if (!fs.existsSync(envPath)) return "";

  const env = fs.readFileSync(envPath, "utf8");
  const line = env.split(/\r?\n/).find((entry) => entry.trim().startsWith("DATABASE_URL="));
  if (!line) return "";

  return line
    .slice(line.indexOf("=") + 1)
    .trim()
    .replace(/^['"]|['"]$/g, "");
}

const databaseUrl = readDatabaseUrl();

if (databaseUrl.startsWith("file:")) {
  const rawPath = databaseUrl.slice("file:".length);
  const dbPath = path.isAbsolute(rawPath)
    ? rawPath
    : path.resolve(schemaDir, rawPath);

  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  fs.closeSync(fs.openSync(dbPath, "a"));
}
