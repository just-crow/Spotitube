// Local admin helper for the Spotitube Supabase project. Not shipped in the app.
// Usage: node scripts/supabase-admin.mjs create-test-user <email> <password>
import { readFileSync } from 'node:fs';

const envPath = new URL('../.env.local', import.meta.url);
const env = Object.fromEntries(
  readFileSync(envPath, 'utf8')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'))
    .map((line) => {
      const index = line.indexOf('=');
      return [line.slice(0, index), line.slice(index + 1)];
    }),
);

const base = env.SUPABASE_URL;
const secret = env.SUPABASE_SECRET_KEY;
if (!base || !secret) {
  console.error('SUPABASE_URL / SUPABASE_SECRET_KEY missing from .env.local');
  process.exit(1);
}

const [command, email, password] = process.argv.slice(2);

if (command === 'create-test-user') {
  if (!email || !password) {
    console.error('Usage: node scripts/supabase-admin.mjs create-test-user <email> <password>');
    process.exit(1);
  }
  const response = await fetch(`${base}/auth/v1/admin/users`, {
    method: 'POST',
    headers: {
      apikey: secret,
      authorization: `Bearer ${secret}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ email, password, email_confirm: true }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    console.error('Failed:', response.status, JSON.stringify(body));
    process.exit(1);
  }
  console.log('OK — confirmed user created:', body.email, `(id ${body.id})`);
} else if (command === 'delete-test-user') {
  if (!email) {
    console.error('Usage: node scripts/supabase-admin.mjs delete-test-user <email>');
    process.exit(1);
  }
  const list = await fetch(
    `${base}/auth/v1/admin/users?page=1&per_page=50`,
    { headers: { apikey: secret, authorization: `Bearer ${secret}` } },
  ).then((r) => r.json());
  const match = (list.users || []).find((u) => u.email === email);
  if (!match) {
    console.log('No user with that email.');
    process.exit(0);
  }
  const del = await fetch(`${base}/auth/v1/admin/users/${match.id}`, {
    method: 'DELETE',
    headers: { apikey: secret, authorization: `Bearer ${secret}` },
  });
  console.log(del.ok ? 'Deleted.' : `Delete failed: ${del.status}`);
} else {
  console.error('Unknown command. Try: create-test-user | delete-test-user');
  process.exit(1);
}
