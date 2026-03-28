---
name: linear
description: Manage issues, projects & team workflows in Linear using the Linear MCP server via mcporter. Use this skill to decide what to read/write and then execute tool calls with `mcporter call linear.<tool>`.
---

# Linear

## Overview

This skill defines *how to work* in Linear (what to ask/confirm, what to read first, and how to batch changes safely).

**Execution rule (important):** when you actually need to interact with Linear, you must call the Linear MCP tools through **mcporter**, e.g.:

- `mcporter list` (see configured servers)
- `mcporter call linear.list_teams`
- `mcporter call linear.list_issues assignee:me limit:20`

Do not use ad-hoc HTTP calls or other tooling paths when mcporter is available.

## Required Workflow

**Follow these steps in order. Do not skip steps.**

### Step 1
Clarify the user's goal and scope (e.g., issue triage, sprint planning, documentation audit, workload balance). Confirm team/project, priority, labels, cycle, and due dates as needed.

### Step 2
Select the appropriate workflow (see Practical Workflows below) and identify the Linear MCP tools you will need. Confirm required identifiers (issue ID, project ID, team key) before calling tools.

### Step 3
Execute Linear MCP tool calls in logical batches:
- Read first (list/get/search) to build context.
- Create or update next (issues, projects, labels, comments) with all required fields.
- For bulk operations, explain the grouping logic before applying changes.

### Step 4
Summarize results, call out remaining gaps or blockers, and propose next actions (additional issues, label changes, assignments, or follow-up comments).

## Available Tools (as exposed by the current Linear MCP server)

> Call via mcporter: `mcporter call linear.<tool> key:value ...`
>
> Tool signatures drift over time. To refresh: `mcporter list linear --schema`.

### Issues / Comments / Attachments / Images

- `list_issues [limit] [cursor] [orderBy] [query] [team] [state] [cycle] [label] [assignee] [delegate] [project] [priority] [parentId] [createdAt] [updatedAt] [includeArchived]`
  - Notes:
    - `assignee` supports: `"me"` or `null` (no assignee)
    - `priority`: 0=None, 1=Urgent, 2=High, 3=Normal, 4=Low

- `get_issue <id> [includeRelations] [includeCustomerNeeds]`

- `save_issue [id] [title] [description] [team] [cycle] [milestone] [priority] [project] [state] [assignee] [delegate] [labels...] [dueDate] [parentId] [estimate] [links...] [blocks...] [blockedBy...] [relatedTo...] [duplicateOf]`
  - Notes:
    - Creating requires at least: `title` + `team`
    - Many relation/link fields are append-only per schema comments

- `list_comments <issueId>`
- `save_comment [id] [issueId] [parentId] <body>`
  - Notes:
    - Creating requires: `issueId` + `body`
    - Updating requires: `id` + `body`
- `delete_comment <id>`

- `get_attachment <id>`
- `create_attachment <issue> <base64Content> <filename> <contentType> [title] [subtitle]`
- `delete_attachment <id>`

- `extract_images <markdown>`

### Teams / Users / Cycles / Status / Labels

- `list_teams [limit] [cursor] [orderBy] [query] [includeArchived] [createdAt] [updatedAt]`
- `get_team <query>`

- `list_users [limit] [cursor] [orderBy] [query] [team]`
- `get_user <query>`

- `list_cycles <teamId> [type]` (type: `current|previous|next`)

- `list_issue_statuses <team>`
- `get_issue_status <id> <name> <team>`

- `list_issue_labels [limit] [cursor] [orderBy] [name] [team]`
- `create_issue_label <name> [description] [color] [teamId] [parent] [isGroup]`

- `list_project_labels [limit] [cursor] [orderBy] [name]`

### Projects / Milestones / Initiatives / Status Updates

- `list_projects [limit] [cursor] [orderBy] [query] [state] [initiative] [team] [member] [label] [createdAt] [updatedAt] [includeMilestones] [includeMembers] [includeArchived]`
- `get_project <query> [includeMilestones] [includeMembers] [includeResources]`
- `save_project [id] [name] [icon] [color] [summary] [description] [state] [startDate] [targetDate] [priority] [addTeams...] [removeTeams...] [setTeams...] [labels...] [lead] [addInitiatives...] [removeInitiatives...] [setInitiatives...]`
  - Notes:
    - Creating requires: `name` + at least one team via `addTeams` or `setTeams`

- `list_milestones <project>`
- `get_milestone <project> <query>`
- `save_milestone <project> [id] [name] [description] [targetDate]`

- `list_initiatives [limit] [cursor] [orderBy] [query] [status] [owner] [parentInitiative] [createdAt] [updatedAt] [includeArchived] [includeProjects] [includeSubInitiatives]`
- `get_initiative <query> [includeProjects] [includeSubInitiatives]`
- `save_initiative [id] [name] [summary] [description] [color] [icon] [status] [targetDate] [owner] [parentInitiative]`

- `get_status_updates [limit] [cursor] [orderBy] <type> [id] [project] [initiative] [user] [createdAt] [updatedAt] [includeArchived]`
- `save_status_update <type> [id] [project] [initiative] [body] [health] [isDiffHidden]`
- `delete_status_update <type> <id>`

### Docs / Customers

- `list_documents [limit] [cursor] [orderBy] [query] [projectId] [initiativeId] [creatorId] [createdAt] [updatedAt] [includeArchived]`
- `get_document <id>`
- `create_document <title> [content] [project] [issue] [icon] [color]`
- `update_document <id> [title] [content] [project] [icon] [color]`

- `search_documentation <query> [page]`

- `list_customers [limit] [cursor] [orderBy] [query] [owner] [status] [tier] [createdAt] [updatedAt] [includeArchived] [includeNeeds]`
- `save_customer [id] [name] [domains...] [externalIds...] [owner] [status] [tier] [revenue] [size]`
- `delete_customer <id>`

- `save_customer_need [id] [body] [customer] [issue] [project] [priority]`
- `delete_customer_need <id>`

## Practical Workflows

- Sprint Planning: Review open issues for a target team, pick top items by priority, and create a new cycle (e.g., "Q1 Performance Sprint") with assignments.
- Bug Triage: List critical/high-priority bugs, rank by user impact, and move the top items to "In Progress."
- Documentation Audit: Search documentation (e.g., API auth), then open labeled "documentation" issues for gaps or outdated sections with detailed fixes.
- Team Workload Balance: Group active issues by assignee, flag anyone with high load, and suggest or apply redistributions.
- Release Planning: Create a project (e.g., "v2.0 Release") with milestones (feature freeze, beta, docs, launch) and generate issues with estimates.
- Cross-Project Dependencies: Find all "blocked" issues, identify blockers, and create linked issues if missing.
- Automated Status Updates: Find your issues with stale updates and add status comments based on current state/blockers.
- Smart Labeling: Analyze unlabeled issues, suggest/apply labels, and create missing label categories.
- Sprint Retrospectives: Generate a report for the last completed cycle, note completed vs. pushed work, and open discussion issues for patterns.

## Tips for Maximum Productivity

- Batch operations for related changes; consider smart templates for recurring issue structures.
- Use natural queries when possible ("Show me what John is working on this week").
- Leverage context: reference prior issues in new requests.
- Break large updates into smaller batches to avoid rate limits; cache or reuse filters when listing frequently.

## Text Formatting (Important)

- This rule applies to **all Linear Markdown text fields**, not only comments, including:
  - issue descriptions
  - comments
  - project/initiative status updates
  - Linear documents
- Always use real Markdown newlines instead of escaped `\\n` text.
- Never send literal `\\n` in plain text payloads unless it is intentionally inside a code snippet.
- Before any write operation, quickly sanity-check that headings, lists, paragraphs, and code blocks render naturally.

## Troubleshooting

- Authentication: Clear browser cookies, re-run OAuth, verify workspace permissions, ensure API access is enabled.
- Tool Calling Errors: Confirm the model supports multiple tool calls, provide all required fields, and split complex requests.
- Missing Data: Refresh token, verify workspace access, check for archived projects, and confirm correct team selection.
- Performance: Remember Linear API rate limits; batch bulk operations, use specific filters, or cache frequent queries.
