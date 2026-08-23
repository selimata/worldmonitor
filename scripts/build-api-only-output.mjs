#!/usr/bin/env node
/**
 * Assembles the static output directory for the API-only deployment.
 *
 * This fork serves the WorldView iOS app's API; the dashboard SPA, the blog and
 * the marketing site live in a separate project (see the fork guard in
 * middleware.ts). So the build skips `vite build` / `build:blog` / `build:pro`
 * entirely and this script produces the `dist/` Vercel expects by copying the
 * static assets that the Edge routes and rewrites still depend on —
 * `robots.*.txt`, `404.html`, `openapi.yaml`, `api/llms.txt`, `.well-known/`.
 *
 * The SPA entry (`index.html`) lives at the repo root, not in `public/`, so
 * nothing here can resurrect the dashboard shell.
 */

import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const source = resolve(root, 'public');
const target = resolve(root, 'dist');

rmSync(target, { recursive: true, force: true });
mkdirSync(target, { recursive: true });

if (existsSync(source)) {
  cpSync(source, target, { recursive: true, dereference: true });
} else {
  console.warn('[build:api] public/ is missing — emitting an empty dist/');
}

console.log(`[build:api] static output ready at ${target}`);
