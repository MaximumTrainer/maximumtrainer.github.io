#!/usr/bin/env node
// Generates data/issues.json for the cross-project issue dashboard.
//
// Public repositories only. See issue #1. The public-only rule is enforced
// three times on purpose:
//   1. `is:public` in the search query
//   2. the workflow's GITHUB_TOKEN, which cannot read other repositories at all
//   3. the isPrivate check in collect() below
// Do not remove any of them without revisiting issue #1.
//
// Usage: GITHUB_TOKEN=... node scripts/fetch-issues.mjs

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ORG = 'MaximumTrainer';
const SEARCH = `org:${ORG} is:issue is:open is:public`;

// Project categories, mirroring the groupings on projects.html. Anything not
// listed here falls into UNCATEGORISED rather than disappearing, so a new
// repository shows up on the dashboard the hour it gets its first issue —
// add it here to file it under the right heading.
const UNCATEGORISED = 'Other';
const CATEGORIES = {
  'Training & Fitness': [
    'MaximumTrainer_Redux', 'SilverSprint', 'freelap-intervals', 'sprint-coach', 'virtualrow',
  ],
  'Developer Tools & Engineering': [
    'SdlcKnowledgeGraph', 'Waymark', 'gatekeeper', 'GopherMesh',
    'Copilot-Jira-Orchestrator', 'chorus', 'white-papers',
  ],
  'Data & LLM Experiments': [
    'OpenFactstore', 'OpenDataMask', 'llm-cad', 'synthetic-fabricate',
  ],
};

const CATEGORY_OF = new Map();
for (const [category, repos] of Object.entries(CATEGORIES)) {
  for (const repo of repos) CATEGORY_OF.set(repo.toLowerCase(), category);
}
const PAGE_SIZE = 100;
const MAX_PAGES = 10; // GitHub search returns at most 1000 results
const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'data', 'issues.json');

const QUERY = `
query($q: String!, $cursor: String) {
  search(query: $q, type: ISSUE, first: ${PAGE_SIZE}, after: $cursor) {
    issueCount
    pageInfo { hasNextPage endCursor }
    nodes {
      ... on Issue {
        id
        number
        title
        url
        createdAt
        updatedAt
        comments { totalCount }
        labels(first: 20) { nodes { name color } }
        assignees(first: 10) { nodes { login } }
        repository { name url description isPrivate }
      }
    }
  }
}`;

async function graphql(token, variables) {
  const res = await fetch('https://api.github.com/graphql', {
    method: 'POST',
    headers: {
      Authorization: `bearer ${token}`,
      'Content-Type': 'application/json',
      'User-Agent': 'maximumtrainer-issue-dashboard',
    },
    body: JSON.stringify({ query: QUERY, variables }),
  });

  if (!res.ok) {
    throw new Error(`GitHub API returned HTTP ${res.status} ${res.statusText}: ${await res.text()}`);
  }

  const body = await res.json();
  if (body.errors?.length) {
    throw new Error(`GitHub GraphQL errors: ${body.errors.map((e) => e.message).join('; ')}`);
  }
  if (!body.data?.search) {
    throw new Error('GitHub GraphQL response contained no search results');
  }
  return body.data.search;
}

async function collect(token) {
  const issues = [];
  const repos = new Map();
  const seen = new Set();
  let cursor = null;
  let issueCount = 0;
  let pages = 0;
  let hasNextPage = true;

  while (hasNextPage && pages < MAX_PAGES) {
    const search = await graphql(token, { q: SEARCH, cursor });
    pages += 1;
    issueCount = search.issueCount;

    for (const node of search.nodes) {
      // Search returns PRs under `type: ISSUE` too; those come back as empty
      // nodes because the fragment only selects Issue fields.
      if (!node?.id || !node.repository) continue;
      if (node.repository.isPrivate) continue; // guard 3 — never trust the query alone
      if (seen.has(node.id)) continue;
      seen.add(node.id);

      const repo = node.repository.name;
      if (!repos.has(repo)) {
        repos.set(repo, {
          name: repo,
          url: node.repository.url,
          description: node.repository.description ?? '',
          category: CATEGORY_OF.get(repo.toLowerCase()) ?? UNCATEGORISED,
          open_issue_count: 0,
        });
      }
      repos.get(repo).open_issue_count += 1;

      issues.push({
        id: node.id,
        repo,
        number: node.number,
        title: node.title,
        url: node.url,
        labels: node.labels.nodes.map((l) => ({ name: l.name, color: l.color })),
        assignees: node.assignees.nodes.map((a) => a.login),
        created_at: node.createdAt,
        updated_at: node.updatedAt,
        comment_count: node.comments.totalCount,
      });
    }

    hasNextPage = search.pageInfo.hasNextPage;
    cursor = search.pageInfo.endCursor;
  }

  // Stable ordering so an unchanged issue set produces a byte-identical file.
  issues.sort((a, b) => b.updated_at.localeCompare(a.updated_at) || a.id.localeCompare(b.id));
  const repoList = [...repos.values()].sort(
    (a, b) => b.open_issue_count - a.open_issue_count || a.name.localeCompare(b.name),
  );

  // Emitted in projects.html order (with Other last) so the page does not have
  // to know the ordering itself.
  const categoryList = [...Object.keys(CATEGORIES), UNCATEGORISED]
    .map((name) => {
      const inCategory = repoList.filter((r) => r.category === name);
      return {
        name,
        repo_count: inCategory.length,
        open_issue_count: inCategory.reduce((sum, r) => sum + r.open_issue_count, 0),
      };
    })
    .filter((c) => c.repo_count > 0);

  return {
    issue_count: issues.length,
    repo_count: repoList.length,
    category_count: categoryList.length,
    truncated: hasNextPage || issueCount > issues.length,
    categories: categoryList,
    repos: repoList,
    issues,
  };
}

function readExisting() {
  try {
    return JSON.parse(readFileSync(OUT, 'utf8'));
  } catch {
    return null;
  }
}

// Compares everything except the timestamp, so an unchanged issue set does not
// produce an hourly empty commit.
function sameContent(a, b) {
  if (!a || !b) return false;
  const strip = ({ generated_at, ...rest }) => JSON.stringify(rest);
  return strip(a) === strip(b);
}

const token = process.env.GITHUB_TOKEN;
if (!token) {
  console.error('GITHUB_TOKEN is not set');
  process.exit(1);
}

const data = { generated_at: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'), ...(await collect(token)) };

if (sameContent(data, readExisting())) {
  console.log(`No change: ${data.issue_count} open issues across ${data.repo_count} repositories.`);
  process.exit(0);
}

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, `${JSON.stringify(data, null, 2)}\n`);
console.log(`Wrote ${data.issue_count} open issues across ${data.repo_count} repositories.`);
if (data.truncated) console.warn('WARNING: results were truncated at the GitHub search limit.');
