import { promisify } from 'util';
import { stat } from 'fs';

import glob from 'glob';
import gzipSize from 'gzip-size';
import fetch from 'node-fetch';
import prettyBytes from 'pretty-bytes';
import { buildFindRenamedFunc, FindRenamed } from './find-renamed';

const { GITHUB_TOKEN, PR_NUMBER } = process.env;

const hiddenDataMarker = 'botsData';

console.log('size-report tokens', {
  GITHUB_TOKEN,
  PR_NUMBER,
});

const globP = promisify(glob);
const statP = promisify(stat);

let ghMdOutput = '';
let ghMdCollapsedOutput = '';

interface FileData {
  name: string;
  path: string;
  size: number;
  gzipSize: number;
}

const ascendingSizeSort = (a: any, b: any) => a.bytesDiff - b.bytesDiff;
const descendingSizeSort = (a: any, b: any) => b.bytesDiff - a.bytesDiff;

function escapeTilde(str: string) {
  return str.replace(/\~/g, '\\~');
}

/**
 * Recursively-read a directory and turn it into an array of FileDatas
 */
function pathsToInfoArray(paths: string[]): Promise<FileData[]> {
  return Promise.all(
    paths.map(async path => {
      const lastSlashIndex = path.lastIndexOf('/');
      const lastHiphenIndex = path.lastIndexOf('-');

      const name = escapeTilde(path.substring(lastSlashIndex + 1, lastHiphenIndex));
      const gzipSizePromise = gzipSize.file(path);
      const statSizePromise = statP(path).then(s => s.size);

      return {
        name,
        path,
        size: await statSizePromise,
        gzipSize: await gzipSizePromise,
      };
    }),
  );
}

function getHiddenData(str: string) {
  const markerIndex = str.indexOf(hiddenDataMarker);
  if (markerIndex === -1) {
    return {
      sizeReport: {},
    };
  }

  const startIndex = markerIndex + hiddenDataMarker.length;

  const remainingStr = str.substring(startIndex);
  const endIndex = remainingStr.indexOf('-->');

  const jsonString = str.substring(startIndex, startIndex + endIndex);
  return JSON.parse(jsonString);
}

function updateCommentId(params: any = {}) {
  const { issueBody, hiddenData, commentId } = params;

  const markerIndex = issueBody.indexOf(`<!--${hiddenDataMarker}`);

  const textEndIndex = markerIndex === -1 ? issueBody.length : markerIndex;

  const text = issueBody.substring(0, textEndIndex).trimRight();

  hiddenData.sizeReport.lastCommentId = commentId;
  const hiddenDataString = `${text}\n\n<!--botsData\n${JSON.stringify(
    hiddenData,
  )}\n-->\n<!-- WARNING: Don't delete the content inside botData -->`;

  return hiddenDataString;
}

function getGitHubIssue(params: any = {}) {
  const { user, repo, pr } = params;
  const url = `https://api.github.com/repos/${user}/${repo}/issues/${pr}`;
  console.log('getGitHubIssue url', url);

  return fetch(url, {
    headers: {
      Authorization: `token ${GITHUB_TOKEN}`,
    },
  });
}

function updateGitHubIssue(params: any = {}, body: any) {
  const { user, repo, pr } = params;
  const url = `https://api.github.com/repos/${user}/${repo}/issues/${pr}`;
  console.log('updateGitHubIssue url', url);

  return fetch(url, {
    method: 'PATCH',
    body: JSON.stringify({ body }),
    headers: {
      'Content-Type': 'application/json',
      Authorization: `token ${GITHUB_TOKEN}`,
    },
  });
}

function commentGitHub(params: any = {}, body: any) {
  const { user, repo, pr } = params;
  const url = `https://api.github.com/repos/${user}/${repo}/issues/${pr}/comments`;
  console.log('commentGitHub url', url);

  return fetch(url, {
    method: 'POST',
    body: JSON.stringify({ body }),
    headers: {
      'Content-Type': 'application/json',
      Authorization: `token ${GITHUB_TOKEN}`,
    },
  });
}

function deleteCommentGitHub(params: any = {}) {
  const { user, repo, commentId } = params;
  const url = `https://api.github.com/repos/${user}/${repo}/issues/comments/${commentId}`;
  console.log('delete url', url);

  return fetch(url, {
    method: 'DELETE',
    headers: {
      Authorization: `token ${GITHUB_TOKEN}`,
    },
  });
}

/**
 * Get previous build info from HackerRank CDN.
 */
async function fetchPreviousBuildInfo(): Promise<FileData[] | undefined> {
  const r = await fetch(
    'https://gist.githubusercontent.com/itaditya/5e2f69caa8da407d77eb466d1e41f46a/raw/050cc5ab2d03905dd1951476ff81819354cef63b/stats.json',
  );
  const json = r.json();
  return json;
}

interface BuildChanges {
  deletedItems: FileData[];
  newItems: FileData[];
  changedItems: Map<FileData, FileData>;
}

/**
 * Generate an array that represents the difference between builds.
 * Returns an array of { beforeName, afterName, beforeSize, afterSize }.
 * Sizes are gzipped size.
 * Before/after properties are missing if resource isn't in the previous/new build.
 */
async function getChanges(
  previousBuildInfo: FileData[],
  buildInfo: FileData[],
  findRenamed?: FindRenamed,
): Promise<BuildChanges> {
  const deletedItems: FileData[] = [];
  const changedItems = new Map<FileData, FileData>();
  const matchedNewEntries = new Set<FileData>();

  for (const oldEntry of previousBuildInfo) {
    const newEntry = buildInfo.find(entry => entry.path === oldEntry.path);
    if (!newEntry) {
      deletedItems.push(oldEntry);
      continue;
    }

    matchedNewEntries.add(newEntry);
    if (oldEntry.gzipSize !== newEntry.gzipSize) {
      changedItems.set(oldEntry, newEntry);
    }
  }

  const newItems: FileData[] = [];

  // Look for entries that are only in the new build.
  for (const newEntry of buildInfo) {
    if (matchedNewEntries.has(newEntry)) continue;
    newItems.push(newEntry);
  }

  // Figure out renamed files.
  if (findRenamed) {
    const originalDeletedItems = deletedItems.slice();
    const newPaths = newItems.map(i => i.path);

    for (const deletedItem of originalDeletedItems) {
      const result = await findRenamed(deletedItem.path, newPaths);
      if (!result) continue;
      if (!newPaths.includes(result)) {
        throw Error(`findRenamed: File isn't part of the new build: ${result}`);
      }

      // Remove items from newPaths, deletedItems and newItems.
      // Add them to mappedItems.
      newPaths.splice(newPaths.indexOf(result), 1);
      deletedItems.splice(deletedItems.indexOf(deletedItem), 1);

      const newItemIndex = newItems.findIndex(i => i.path === result);
      changedItems.set(deletedItem, newItems[newItemIndex]);
      newItems.splice(newItemIndex, 1);
    }
  }

  return { newItems, deletedItems, changedItems };
}

function output(text: string) {
  ghMdOutput = ghMdOutput + '\n' + text;
}

function collapsedOutput(text: string) {
  ghMdCollapsedOutput = ghMdCollapsedOutput + '\n' + text;
}

function outputChanges(changes: BuildChanges) {
  if (
    changes.newItems.length === 0 &&
    changes.deletedItems.length === 0 &&
    changes.changedItems.size === 0
  ) {
    output(`#### :raised_hands:   No changes.`);
    return;
  }

  output(`### Changes in existing chunks :pencil2:`);
  output(`| Size Change | Current Size | Status | Chunk`);
  output(`| --- | --- | :---: | :--- |`);

  const increasedChunks: any = [];
  const decreasedChunks: any = [];
  const minorIncChunks: any = [];
  const minorDecChunks: any = [];
  const renamedChunks: any = [];

  for (const [oldFile, newFile] of changes.changedItems.entries()) {
    // Changed file.
    const size = prettyBytes(newFile.gzipSize);

    const bytesDiff = newFile.gzipSize - oldFile.gzipSize;
    const sizeDiff = prettyBytes(bytesDiff, { signed: true });
    const changeEmoji =
      newFile.gzipSize > oldFile.gzipSize ? ':small_red_triangle:' : ':arrow_down:';

    const chunkData = {
      sizeDiff,
      size,
      bytesDiff,
      changeEmoji,
      name: newFile.name,
    };

    if (bytesDiff > 100) {
      increasedChunks.push(chunkData);
    } else if (bytesDiff > 0) {
      minorIncChunks.push(chunkData);
    }

    if (bytesDiff < -100) {
      decreasedChunks.push(chunkData);
    } else if (bytesDiff < 0) {
      minorDecChunks.push(chunkData);
    }

    if (bytesDiff === 0) {
      chunkData.changeEmoji = ':o:';
      renamedChunks.push(chunkData);
    }
  }

  increasedChunks.sort(descendingSizeSort);
  decreasedChunks.sort(ascendingSizeSort);

  minorIncChunks.sort(descendingSizeSort);
  minorDecChunks.sort(ascendingSizeSort);

  const majorChunks = [...increasedChunks, ...decreasedChunks];
  const minorChunks = [...renamedChunks, ...minorIncChunks, ...minorDecChunks];

  for (const chunk of majorChunks) {
    const { sizeDiff, size, changeEmoji, name } = chunk;
    output(`| **${sizeDiff}** | ${size} | ${changeEmoji} | ${name}`);
  }

  output(`### New chunks :heavy_plus_sign:`);
  output(`Size | Status | Chunk`);
  output(`| --- | :---: | :--- |`);
  for (const file of changes.newItems) {
    const size = prettyBytes(file.gzipSize);
    output(`| **${size}** | :exclamation: | ${file.name}`);
  }

  output(`### Removed chunks :heavy_minus_sign:`);
  output(`Size | Status | Chunk`);
  output(`| --- | :---: | :--- |`);
  for (const file of changes.deletedItems) {
    const size = prettyBytes(file.gzipSize);
    output(`| **${size}** | :negative_squared_cross_mark: | ${file.name}`);
  }

  collapsedOutput(`| Size Change | Current Size | Status | Chunk`);
  collapsedOutput(`| --- | --- | :---: | :--- |`);

  for (const chunk of minorChunks) {
    const { sizeDiff, size, changeEmoji, name } = chunk;
    collapsedOutput(`| ${sizeDiff} | ${size} | ${changeEmoji} | ${name}`);
  }
}

export interface SizeReportOptions {
  /** Branch to compare to. Defaults to 'master' */
  branch?: string;
  /**
   * Join together a missing file and a new file which should be considered the same (as in,
   * renamed).
   *
   * Return nothing to indicate `filePath` has been removed from the new build, or return one of the
   * strings in `newFiles` to treat it as a rename.
   *
   * This can be async, returning a promise for a string or undefined.
   */
  findRenamed?: string | FindRenamed;
}

export default async function sizeReport(
  user: string,
  repo: string,
  files: string | readonly string[],
  { branch = 'master', findRenamed }: SizeReportOptions = {},
): Promise<void> {
  if (typeof files === 'string') files = [files];
  if (typeof findRenamed === 'string') findRenamed = buildFindRenamedFunc(findRenamed);

  // Get target files
  const filePaths = [];

  for (const glob of files) {
    const matches = await globP(glob, { nodir: true });
    filePaths.push(...matches);
  }

  const pr = PR_NUMBER;

  const uniqueFilePaths = [...new Set(filePaths)];

  // Output the current build sizes for later retrieval.
  const buildInfo = await pathsToInfoArray(uniqueFilePaths);
  console.log('=== Build Size ===');
  console.log(buildInfo);

  console.log('\nBuild change report sending to GitHub PR as comment:');

  let previousBuildInfo;

  try {
    previousBuildInfo = await fetchPreviousBuildInfo();
  } catch (err) {
    console.log(`  Couldn't parse previous build info`);
    return;
  }

  if (!previousBuildInfo) {
    console.log(`  Couldn't find previous build info`);
    return;
  }

  const buildChanges = await getChanges(previousBuildInfo, buildInfo, findRenamed);
  outputChanges(buildChanges);
  ghMdOutput += `\n<details><summary>Minor Changes</summary>\n${ghMdCollapsedOutput}\n</details>`;

  console.log('=== Changes ===');
  console.log(ghMdOutput);

  const issueRes = await getGitHubIssue({ user, repo, pr });
  const issueData = await issueRes.json();
  const issueBody = issueData.body;

  const hiddenData = getHiddenData(issueBody);
  const { lastCommentId } = hiddenData.sizeReport;

  const commentRes = await commentGitHub({ user, repo, pr }, ghMdOutput);
  const commentData = await commentRes.json();
  const commentId = commentData.id;

  const updatedIssueBody = updateCommentId({ issueBody, hiddenData, commentId });

  await updateGitHubIssue({ user, repo, pr }, updatedIssueBody);
  await deleteCommentGitHub({ user, repo, commentId: lastCommentId });
}
