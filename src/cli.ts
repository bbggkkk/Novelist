#!/usr/bin/env node
import { writeSync } from "node:fs";
import { parseCliArgs } from "./cliArgs.js";
import { writeCliOutput } from "./cliIo.js";
import { createStdioServer } from "./mcp.js";
import { startupErrorJsonLine } from "./startup.js";
import { PACKAGE_NAME, PACKAGE_VERSION } from "./version.js";

const HELP_TEXT = `${PACKAGE_NAME} ${PACKAGE_VERSION}

Usage:
  ${PACKAGE_NAME} [--help] [--version]

Starts the Novelist MCP stdio server when no options are provided.
`;

try {
  const action = parseCliArgs(process.argv.slice(2));
  if (action === "start") {
    createStdioServer();
  } else if (action === "help") {
    writeCliOutput(writeSync, 1, HELP_TEXT);
  } else {
    writeCliOutput(writeSync, 1, `${PACKAGE_VERSION}\n`);
  }
} catch (error) {
  writeCliOutput(writeSync, 2, startupErrorJsonLine(error));
  process.exitCode = 1;
}
