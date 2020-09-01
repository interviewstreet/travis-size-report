#!/usr/bin/env node

import { getConfig } from './cli';
import sizeReport from '.';

const config = getConfig();
console.log('config2', config);

const opts = {};
if (config.findRenamed) opts.findRenamed = config.findRenamed;

const [user, repoName] = config.repo.split('/');
sizeReport(user, repoName, config.path, config.cdnUrl, opts);
