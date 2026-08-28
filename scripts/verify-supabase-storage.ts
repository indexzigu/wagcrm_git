import "dotenv/config";
import { supabaseStorageProvider, isSupabaseStorageConfigured } from "../src/lib/asset-storage";
import { getPrisma } from "../src/lib/prisma";

async function main() {
  console.log("=== Supabase Storage Integration Verification ===");

  const configured = isSupabaseStorageConfigured();
  console.log(`- Storage configuration status: ${configured ? "CONFIGURED" : "NOT CONFIGURED"}`);

  if (!configured) {
    console.error("[ERROR] Supabase storage is not configured. Please check your .env credentials.");
    process.exit(1);
  }

  const testFileBytes = new TextEncoder().encode("This is a temporary integration test file for WAG CRM Storage.");
  const testInput = {
    fileName: `storage-smoke-test-${Math.random().toString(36).slice(2)}.txt`,
    mimeType: "text/plain",
    sizeBytes: testFileBytes.length,
    bytes: testFileBytes,
    section: "ETC" as const,
    entityType: "CAMPAIGN" as const,
    entityId: "smoke-test-entity",
    entityName: "smoke-test-campaign",
  };

  let uploadedPath: string | undefined;

  try {
    console.log("- Step 1: Uploading temporary test file to Supabase Storage...");
    const uploadResult = await supabaseStorageProvider.upload(testInput);
    console.log(`  [SUCCESS] File uploaded. Provider: ${uploadResult.provider}, Storage Path: ${uploadResult.storagePath}`);
    
    uploadedPath = uploadResult.storagePath;

    if (!uploadedPath) {
      throw new Error("Upload succeeded but returned empty storage path.");
    }

    console.log("- Step 2: Generating Signed Download URL...");
    const downloadUrl = await supabaseStorageProvider.getDownloadUrl({
      storagePath: uploadedPath,
    });

    console.log(`  [SUCCESS] Signed URL: ${downloadUrl}`);
    if (!downloadUrl) {
      throw new Error("Failed to generate signed URL.");
    }

    console.log("- Step 3: Fetching Signed URL to verify download accessibility...");
    const fetchResponse = await fetch(downloadUrl);
    if (!fetchResponse.ok) {
      throw new Error(`Failed to download uploaded file: HTTP ${fetchResponse.status}`);
    }
    const content = await fetchResponse.text();
    console.log(`  [SUCCESS] File content matches: "${content}"`);

  } catch (error) {
    console.error("[ERROR] Supabase Storage verification failed:", error);
    process.exit(1);
  } finally {
    if (uploadedPath) {
      console.log("- Step 4: Cleaning up temporary test file...");
      try {
        await supabaseStorageProvider.delete({ storagePath: uploadedPath });
        console.log("  [SUCCESS] Temporary file deleted successfully.");
      } catch (deleteError) {
        console.error("  [WARNING] Failed to clean up temporary file:", deleteError);
      }
    }
  }

  console.log("\n=== Supabase Storage Verification PASSED ===");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
