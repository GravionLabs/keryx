#!/usr/bin/env node
import { run } from './run.js';

process.exitCode = run(process.argv.slice(2), (line) => console.log(line));
