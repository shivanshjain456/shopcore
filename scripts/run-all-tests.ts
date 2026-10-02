/**
 * ShopCore — Master Test Suite Runner
 *
 * Runs core automated tests across auth, pricing, domain rules,
 * security boundaries, accessibility, and UI components in a clean process.
 *
 * Usage:
 *   npm test
 *   npx tsx scripts/run-all-tests.ts
 */
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

interface TestSuite {
  name: string;
  script: string;
  description: string;
}

const SUITES: TestSuite[] = [
  {
    name: 'preflight',
    script: 'scripts/preflight.ts',
    description: 'Database schema integrity, migration status, configuration checks',
  },
  {
    name: 'test:no-native-dialogs',
    script: 'scripts/test-no-native-dialogs.ts',
    description: 'Static audit: ensures no unhandled window.alert/confirm/prompt calls',
  },
  {
    name: 'test:loyalty',
    script: 'scripts/test-loyalty.ts',
    description: 'Integer-money math, cashback calculation, and order integration',
  },
  {
    name: 'test:variant-price',
    script: 'scripts/test-variant-price.ts',
    description: 'Server-side variant price selection and cart line total verification',
  },
  {
    name: 'test:dialog',
    script: 'scripts/test-dialog.tsx',
    description: 'AppDialog modal accessibility, focus management, and async resolution',
  },
  {
    name: 'test:hero-carousel',
    script: 'scripts/test-hero-carousel.tsx',
    description: 'Homepage hero carousel keyboard navigation and touch swipe',
  },
  {
    name: 'test:otp-input',
    script: 'scripts/test-otp-input.tsx',
    description: '6-digit OTP component accessibility, paste parsing, and navigation',
  },
  {
    name: 'test:share-dialog',
    script: 'scripts/test-share-dialog.tsx',
    description: 'Multi-channel share modal, clipboard fallback, and UTM parameters',
  },
  {
    name: 'test:responsive',
    script: 'scripts/test-responsive.tsx',
    description: 'Fluid layout audits, 44px tap targets, and responsive table containers',
  },
  {
    name: 'test:logout-ui',
    script: 'scripts/test-logout-ui.tsx',
    description: 'Client logout lifecycle, multi-cookie revocation, and bfcache guard',
  },
  {
    name: 'test:image-upload-input',
    script: 'scripts/test-image-upload-input.tsx',
    description: 'Drag-and-drop image uploads, MIME type checks, and Sharp re-encode',
  },
  {
    name: 'test:pincode-ui',
    script: 'scripts/test-pincode-ui.tsx',
    description: 'India Post PIN code debounced autocomplete and state serviceability',
  },
  {
    name: 'test:auth',
    script: 'scripts/test-auth.ts',
    description: 'Authentication lifecycle: signup, email OTP, bcrypt, and rate limiting',
  },
];

async function main() {
  console.log('===============================================================');
  console.log('            ShopCore — Automated Verification Suite             ');
  console.log('===============================================================\n');

  let passed = 0;
  let failed = 0;
  const startAll = Date.now();

  for (const suite of SUITES) {
    const fullPath = resolve(suite.script);
    console.log(`\n▶ [${suite.name}] ${suite.description}`);
    const start = Date.now();

    const result = spawnSync('npx', ['tsx', fullPath], {
      stdio: 'inherit',
      shell: true,
      env: {
        ...process.env,
        NODE_ENV: 'test',
        SHOPCORE_ALLOW_TEST_EMAILS: '1',
      },
    });

    const duration = ((Date.now() - start) / 1000).toFixed(2);

    if (result.status === 0) {
      passed++;
      console.log(`✔ [${suite.name}] Passed (${duration}s)`);
    } else {
      failed++;
      console.error(`✘ [${suite.name}] Failed with exit code ${result.status} (${duration}s)`);
      // Fail-fast on verification failure
      process.exit(result.status ?? 1);
    }
  }

  const totalTime = ((Date.now() - startAll) / 1000).toFixed(2);
  console.log('\n===============================================================');
  console.log(`Results: ${passed} passed, ${failed} failed in ${totalTime}s`);
  console.log('===============================================================\n');
}

main().catch((err) => {
  console.error('Test runner fatal error:', err);
  process.exit(1);
});
