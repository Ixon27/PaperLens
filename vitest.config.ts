import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineConfig } from 'vitest/config';

// Server modules create their data dirs on import; keep tests away from the real ones.
const scratch = join(tmpdir(), 'paper-reader-test');

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    env: {
      PAPER_READER_DB_DIR: join(scratch, 'db'),
      PAPER_READER_FILES: join(scratch, 'files'),
      PAPER_READER_VAULT: join(scratch, 'vault'),
    },
  },
});
