/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const {cat, echo, exec, exit, sed} = require('shelljs');
const yargs = require('yargs');
const {parseVersion, validateBuildType} = require('./version-utils');
const {saveFiles} = require('./scm-utils');
const updateTemplatePackage = require('./update-template-package');
const {applyPackageVersions} = require('./npm-utils');

/**
 * This script updates relevant React Native files with supplied version:
 *   * Prepares a package.json suitable for package consumption
 *   * Updates package.json for template project
 *   * Updates the version in gradle files and makes sure they are consistent between each other
 *   * Creates a gemfile
 */
if (require.main === module) {
  let argv = yargs
    .option('v', {
      alias: 'to-version',
      type: 'string',
      required: true,
    })
    .option('d', {
      alias: 'dependency-versions',
      type: 'string',
      describe:
        'JSON string of package versions. Ex. "{"react-native":"0.64.1"}"',
      default: null,
    })
    .coerce('d', dependencyVersions => {
      if (dependencyVersions == null) {
        return null;
      }
      return JSON.parse(dependencyVersions);
    })
    .option('b', {
      alias: 'build-type',
      type: 'string',
      choices: ['dry-run', 'nightly', 'release'],
      required: true,
    }).argv;

  setReactNativeVersion(
    argv.toVersion,
    argv.dependencyVersions,
    argv.buildType,
  );
  exit(0);
}

function setSource({major, minor, patch, prerelease}) {
  fs.writeFileSync(
    'packages/react-native/ReactAndroid/src/main/java/com/facebook/react/modules/systeminfo/ReactNativeVersion.java',
    cat('scripts/versiontemplates/ReactNativeVersion.java.template')
      .replace('${major}', major)
      .replace('${minor}', minor)
      .replace('${patch}', patch)
      .replace(
        '${prerelease}',
        prerelease !== undefined ? `"${prerelease}"` : 'null',
      ),
    'utf-8',
  );

  fs.writeFileSync(
    'packages/react-native/React/Base/RCTVersion.m',
    cat('scripts/versiontemplates/RCTVersion.m.template')
      .replace('${major}', `@(${major})`)
      .replace('${minor}', `@(${minor})`)
      .replace('${patch}', `@(${patch})`)
      .replace(
        '${prerelease}',
        prerelease !== undefined ? `@"${prerelease}"` : '[NSNull null]',
      ),
    'utf-8',
  );

  fs.writeFileSync(
    'packages/react-native/ReactCommon/cxxreact/ReactNativeVersion.h',
    cat('scripts/versiontemplates/ReactNativeVersion.h.template')
      .replace('${major}', major)
      .replace('${minor}', minor)
      .replace('${patch}', patch)
      .replace(
        '${prerelease}',
        prerelease !== undefined ? `"${prerelease}"` : '""',
      ),
    'utf-8',
  );

  fs.writeFileSync(
    'packages/react-native/Libraries/Core/ReactNativeVersion.js',
    cat('scripts/versiontemplates/ReactNativeVersion.js.template')
      .replace('${major}', major)
      .replace('${minor}', minor)
      .replace('${patch}', patch)
      .replace(
        '${prerelease}',
        prerelease !== undefined ? `'${prerelease}'` : 'null',
      ),
    'utf-8',
  );
}

// Change ReactAndroid/gradle.properties
function setGradle({version}) {
  const result = sed(
    '-i',
    /^VERSION_NAME=.*/,
    `VERSION_NAME=${version}`,
    'packages/react-native/ReactAndroid/gradle.properties',
  );
  if (result.code) {
    echo("Couldn't update version for Gradle");
    throw result.stderr;
  }
}

function setPackage({version}, dependencyVersions) {
  const originalPackageJson = JSON.parse(
    cat('packages/react-native/package.json'),
  );
  const packageJson =
    dependencyVersions != null
      ? applyPackageVersions(originalPackageJson, dependencyVersions)
      : originalPackageJson;

  packageJson.version = version;

  fs.writeFileSync(
    'packages/react-native/package.json',
    JSON.stringify(packageJson, null, 2),
    'utf-8',
  );
}

function setReactNativeVersion(argVersion, dependencyVersions, buildType) {
  validateBuildType(buildType);

  const version = parseVersion(argVersion, buildType);

  // Create tmp folder for copies of files to verify files have changed
  const filesToValidate = [
    'packages/react-native/package.json',
    'packages/react-native/ReactAndroid/gradle.properties',
    'packages/react-native/template/package.json',
  ];
  const tmpVersioningFolder = fs.mkdtempSync(
    path.join(os.tmpdir(), 'rn-set-version'),
  );
  echo(`The tmp versioning folder is ${tmpVersioningFolder}`);
  saveFiles(tmpVersioningFolder);

  setSource(version);
  setPackage(version, dependencyVersions);

  const templateDependencyVersions = {
    'react-native': version.version,
    ...(dependencyVersions != null ? dependencyVersions : {}),
  };
  updateTemplatePackage(templateDependencyVersions);

  setGradle(version);

  // Validate changes
  // We just do a git diff and check how many times version is added across files
  const numberOfChangedLinesWithNewVersion = exec(
    `diff -r ${tmpVersioningFolder} . | grep '^[>]' | grep -c ${version.version} `,
    {silent: true},
  ).stdout.trim();

  if (+numberOfChangedLinesWithNewVersion !== filesToValidate.length) {
    // TODO: the logic that checks whether all the changes have been applied
    // is missing several files. For example, it is not checking Ruby version nor that
    // the Objecive-C files, the codegen and other files are properly updated.
    // We are going to work on this in another PR.
    echo('WARNING:');
    echo(
      `Failed to update all the files: [${filesToValidate.join(
        ', ',
      )}] must have versions in them`,
    );
    echo(`These files already had version ${version.version} set.`);
  }

  return;
}

module.exports = setReactNativeVersion;
