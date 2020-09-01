#!/usr/bin/env node
import path from 'path';
import fs from 'fs';
import { getConfig } from './cli';
import { getBuildInfo } from './utils';

const config = getConfig();
console.log('config1', config);

async function init() {
  const dir = process.cwd();
  const outputFilePath = path.join(dir, config.buildSizePath, 'buildsize.json');
  const buildInfo = await getBuildInfo(config.path);
  fs.writeFileSync(outputFilePath, JSON.stringify(buildInfo));
}

init();
