import { PrismaClient } from "@prisma/client";

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
  prismaPragma: boolean | undefined;
};

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: process.env.NODE_ENV === "development" ? ["warn", "error"] : ["error"],
  });

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = prisma;

// SQLite concurrency hardening: WAL lets readers and a writer coexist, and a busy
// timeout makes a blocked write wait instead of throwing "database is locked" — which
// otherwise surfaces as an app crash when the background scheduler and a user action
// touch the DB at the same time.
if (!globalForPrisma.prismaPragma) {
  globalForPrisma.prismaPragma = true;
  // PRAGMAs return a row, so use queryRawUnsafe (executeRawUnsafe rejects results).
  Promise.all([
    prisma.$queryRawUnsafe("PRAGMA journal_mode=WAL;"),
    prisma.$queryRawUnsafe("PRAGMA busy_timeout=8000;"),
  ]).catch(() => undefined);
}
