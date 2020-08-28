#!/usr/bin/env node
import path from 'path';
import fs from 'fs';
import { getConfig } from './cli';
import { getBuildInfo } from './utils';

const config = getConfig();
const opts = {};
if (config.branch) opts.branch = config.branch;
if (config.findRenamed) opts.findRenamed = config.findRenamed;

let files = config.path;
if (typeof files === 'string') files = [files];

async function init() {
  const dir = process.cwd();
  const outputFilePath = path.join(dir, 'public', 'assets', 'buildsize.json');
  const buildInfo = await getBuildInfo(files);
  fs.writeFileSync(outputFilePath, JSON.stringify(buildInfo));
}

init();
