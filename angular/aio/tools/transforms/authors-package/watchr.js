/* eslint no-console: "off" */
const watchr = require('watchr');
const {resolve, relative} = require('canonical-path');
const {generateDocs} = require('./index.js');
const rootPath = resolve(__dirname, '../../../..');
const contentsPath = resolve(rootPath, 'aio/content');
const apiPath = resolve(rootPath, 'packages');

function listener(changeType, fullPath) {
  try {
    const relativePath = relative(rootPath, fullPath);
    console.log('The file', relativePath, `was ${changeType}d at`, new Date().toUTCString());
    generateDocs(relativePath);
  } catch(err) {
    console.log('Error generating docs', err);
  }
}

function next(error) {
  if (error) {
    console.log(error);
  }
}

let p = Promise.resolve();

if (process.argv.indexOf('--watch-only') === -1) {
  console.log('===================================================================');
  console.log('Running initial doc generation');
  console.log('-------------------------------------------------------------------');
  console.log('Skip the full doc-gen by running: `yarn docs-watch -- --watch-only`');
  console.log('===================================================================');
  const {Dgeni} = require('dgeni');
  var dgeni = new Dgeni([require('../angular.io-package')]);
  p = dgeni.generate();
}

p.then(() => {
  console.log('===================================================================');
  console.log('Started watching files in:');
  console.log(' - ', contentsPath);
  console.log(' - ', apiPath);
  console.log('Doc gen will run when you change a file in either of these folders.');
  console.log('===================================================================');

  watchr.open(contentsPath, listener, next);
  watchr.open(apiPath, listener, next);

});