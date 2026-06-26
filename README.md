# novelist-mcp

MCP server for a fixed, resumable novel-writing pipeline.

The server does not call a separate LLM. The MCP-calling agent writes and checks artifacts, then submits them through MCP tools. The server only manages state, storage, ordering, validation, and EPUB export.

## Storage

Project data is always stored under the current working directory:

```text
.novelist/
```

Storage is project-local and resolved from the server process working directory.

## Pipeline

The pipeline is fixed:

```text
novel_start / resume
→ franchise world
→ franchise setting
→ work world
→ work setting
→ volume world
→ volume setting
→ volume outline
→ writing
→ epub
→ complete
```

Each world/setting level depends on the already finalized parent levels. Writing depends on all finalized world and setting documents, the finalized volume outline, and previous beats.

World documents describe how the world works. Setting documents describe concrete entities and facts: characters, objects, possession, relationships, and state changes.

## Consistency

Consistency is binary:

```json
{
  "ok": true,
  "checkedAgainst": ["franchise.world"],
  "issues": []
}
```

If `ok` is `false`, the pipeline stays on the same phase with `flowStatus: "needs_input"` until a passing report is submitted.

## MCP Tools

- `novel_start`: create or resume a franchise/work/volume pipeline.
- `novel_start_volume`: create or resume another volume under an existing franchise/work.
- `novel_next`: return the current phase and required next action.
- `novel_status`: return current pipeline status.
- `novel_submit_world`: submit the required world document and binary consistency report.
- `novel_finalize_world`: finalize the current world document and advance.
- `novel_submit_setting`: submit the required setting document and binary consistency report.
- `novel_finalize_setting`: finalize the current setting document and advance.
- `novel_submit_outline`: submit the volume outline plus chapter/beat structure and binary consistency report.
- `novel_finalize_outline`: finalize the outline and enter writing.
- `novel_save_beat_draft`: save the current beat draft without completing it.
- `novel_submit_beat`: submit the current beat manuscript and binary consistency report.
- `novel_rewrite_beat`: rewrite an existing beat with a binary consistency report.
- `novel_build_epub`: build EPUB after all beats are complete.
- `novel_health`: report server health.
- `novel_job_*`: optional background job management for supported pipeline tools.

Tools are state-gated. Calling a tool outside the current phase fails.

## Development

```sh
npm run build
npm test
```

`npm test` currently performs the runtime TypeScript build.
