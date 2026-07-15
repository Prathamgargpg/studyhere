const { PrismaClient } = require('@prisma/client');

// Reuse a single PrismaClient instance across the app (avoids exhausting
// Postgres connections during development hot-reloads).
const prisma = global.__studyherePrisma || new PrismaClient();
if (process.env.NODE_ENV !== 'production') {
  global.__studyherePrisma = prisma;
}

module.exports = prisma;
