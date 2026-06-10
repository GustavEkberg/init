import { config } from 'dotenv';
import { defineConfig } from 'drizzle-kit';
import { isLocalDbUrl, stripSslMode } from './lib/services/db/url';

config({ path: '.env.local' });

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error('DATABASE_URL env variable not found');

// stripSslMode: drizzle-kit parses the URL via pg-connection-string, which
// warns on sslmode=prefer|require|verify-ca. SSL is controlled via `ssl` below.
const url = stripSslMode(DATABASE_URL);

export default defineConfig({
  schema: './lib/services/db/schema.ts',
  out: './lib/services/db/migrations',
  dialect: 'postgresql',
  dbCredentials: {
    url,
    ssl: isLocalDbUrl(url) ? false : 'require'
  }
});
