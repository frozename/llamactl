/**
 * Fetcher registry — single map from `kind` to implementation. Keeps
 * the runtime decoupled from specific fetchers so new sources (git,
 * s3, unstructured.io) can plug in without touching the orchestrator.
 */
import type { Fetcher } from '../types.js';
import { filesystemFetcher } from './filesystem.js';
import { httpFetcher } from './http.js';
import { gitFetcher } from './git.js';

export const FETCHERS: Record<string, Fetcher> = {
  filesystem: filesystemFetcher,
  http: httpFetcher,
  git: gitFetcher,
};
