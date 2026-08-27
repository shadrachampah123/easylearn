import "dotenv/config";
import { db } from "./src/db/index";
import { users } from "./src/db/schema";
import bcrypt from "bcryptjs";

async function main() {
  try {
    const passwordHash = await bcrypt.hash("admin123", 10);
    await db.insert(users).values({
      email: "admin@cbism.edu",
      username: "admin",
      passwordHash: passwordHash,
      role: "school_admin",
      firstName: "System",
      lastName: "Admin",
      isActive: true,
      mustChangePassword: false,
    }).onConflictDoNothing();
    console.log("✅ SUCCESS: ADMIN ACCOUNT CREATED!");
  } catch (err) {
    console.error("Error creating admin:", err);
  }
  process.exit(0);
}

main();
