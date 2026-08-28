import { getPrisma } from "../src/lib/prisma";

async function main() {
  const prisma = getPrisma();
  console.log("Listing all tables in public schema of the database...");
  const tables = await prisma.$queryRaw`
    SELECT table_name 
    FROM information_schema.tables 
    WHERE table_schema = 'public' 
    ORDER BY table_name;
  `;
  console.log("Tables:", tables);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    // Wait for prisma disconnect if needed
  });
