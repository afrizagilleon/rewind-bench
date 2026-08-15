/**
 * CLI script to log in to zaatool and print the session token (R2.2).
 *
 * Usage:
 *   npm run auth
 */

const baseUrl = (process.env.ZAA_BASE_URL?.trim() || "http://localhost:4000").replace(/\/+$/, "");
const username = process.env.ZAA_USERNAME?.trim();
const password = process.env.ZAA_PASSWORD?.trim();

if (!username || !password) {
  console.error("ZAA_USERNAME and ZAA_PASSWORD must be set in environment or .env");
  process.exit(1);
}

async function main() {
  try {
    const res = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password }),
    });

    if (!res.ok) {
      let errorMsg = res.statusText;
      try {
        const errJson = await res.json();
        if (errJson?.error) errorMsg = errJson.error;
      } catch {
        // ignore
      }
      console.error(`Authentication failed (HTTP ${res.status}): ${errorMsg}`);
      process.exit(1);
    }

    const data = await res.json();
    if (!data.token) {
      console.error("Authentication succeeded but no token was returned in response");
      process.exit(1);
    }

    // Print token for manual placement in .env
    console.log(data.token);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`Authentication request failed: ${message}`);
    process.exit(1);
  }
}

main();
