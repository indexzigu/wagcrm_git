import { readFileSync } from "node:fs";
import { join } from "node:path";

type MigrationSpec = {
  name: string;
  summary: string;
};

const SALES_TASK_MIGRATIONS: MigrationSpec[] = [
  {
    name: "20260519130000_add_sales_tasks",
    summary: "Creates the SalesTask table and indexes for the sales-management workspace.",
  },
  {
    name: "20260520003000_add_sales_task_notes",
    summary: "Adds negotiationMemo and testingMemo fields to SalesTask.",
  },
];

function readMigrationSql(name: string) {
  const path = join(process.cwd(), "prisma", "migrations", name, "migration.sql");
  return readFileSync(path, "utf8").trim();
}

function printPlan() {
  console.log("# SalesTask remote sync plan");
  console.log("");
  console.log(
    "This plan keeps the active sales-management model aligned across local Prisma history and the remote Supabase/Postgres schema.",
  );
  console.log("");
  console.log("Apply in this exact order:");
  console.log("1. Run the SQL for each migration in Supabase SQL Editor if the remote DB does not already have it.");
  console.log("2. Mark the same migrations as applied in Prisma migration history.");
  console.log("3. Verify with `npx prisma migrate status`.");
  console.log("");

  for (const migration of SALES_TASK_MIGRATIONS) {
    console.log(`## ${migration.name}`);
    console.log(migration.summary);
    console.log("");
    console.log("Prisma history sync command:");
    console.log(`npx prisma migrate resolve --applied ${migration.name}`);
    console.log("");
  }

  console.log("Final verification:");
  console.log("npx prisma migrate status");
}

function printSql() {
  for (const migration of SALES_TASK_MIGRATIONS) {
    console.log(`-- ${migration.name}`);
    console.log(`-- ${migration.summary}`);
    console.log(readMigrationSql(migration.name));
    console.log("");
  }
}

const wantsSql = process.argv.includes("--sql");

if (wantsSql) {
  printSql();
} else {
  printPlan();
}
