'use strict';
import * as vscode from 'vscode';
import * as path from 'path';
import * as child_process from 'child_process';
import * as fs from 'fs';

// import { blk } from './blk';
import { blk } from './blk-pegjs';
import { log } from 'console';

const g_mount_point_include_pattern = new RegExp("(?:\\binclude\\b)(?:\\s+)[\"']%(.*)[\"']", 'gi');
const g_absolute_include_pattern = new RegExp("(?:\\binclude\\b)(?:\\s+)[\"']#(.*)[\"']", 'gi');
const g_relative_include_pattern = new RegExp("(?:\\binclude\\b)(?:\\s+)[\"']([^#].*)[\"']", 'gi');
const g_include_in_string_pattern = new RegExp("[\"'](.*\.blk)[\"']", 'gi');

let g_search_in_progress = false;
let g_should_stop_search = false;

const g_match_operators_re = /[|\\{}()[\]^$+*?.]/g;

function escapeRegExp(str)
{
  return str.replace(g_match_operators_re, '\\$&');
};

let g_out: vscode.OutputChannel = null;

function logLine(line: string)
{
  if (g_out)
    g_out.appendLine(line);
}

function onFileOpenError(reason)
{
  vscode.window.showErrorMessage(reason.message);
}

function getFilename(uri: vscode.Uri | string)
{
  let filePath = uri instanceof vscode.Uri ? (<vscode.Uri>uri).fsPath : uri;
  return path.basename(filePath);
}

function getPath(uri: vscode.Uri | string)
{
  let filePath = uri instanceof vscode.Uri ? (<vscode.Uri>uri).fsPath : uri;
  return filePath.replace(getFilename(uri), '');
}

function findAllIncludes(document: vscode.TextDocument)
{

  for (let lineNo = 0; lineNo < document.lineCount; ++lineNo)
  {
    let line = document.lineAt(lineNo).text;
    let absMatch = g_absolute_include_pattern.exec(line);
    g_absolute_include_pattern.lastIndex = 0;
    let relMatch = g_relative_include_pattern.exec(line);
    g_relative_include_pattern.lastIndex = 0;

    if (relMatch)
    {
    }

    if (absMatch)
    {
    }
  }

}

function hasInclude(document: vscode.TextDocument, include_name: string)
{

  let includePattern = new RegExp("(?:include)(?:\\s+)[\"'](?:.*)" + escapeRegExp(include_name) + "[\"']", 'gi');

  for (let lineNo = 0; lineNo < document.lineCount; ++lineNo)
  {
    let line = document.lineAt(lineNo).text;
    if (includePattern.test(line))
    {
      return true;
    }
    includePattern.lastIndex = 0;
  }

  return false;
}

function getFilenameFromInclude(text: string)
{
  let mpMatch = g_mount_point_include_pattern.exec(text);
  g_mount_point_include_pattern.lastIndex = 0;
  if (mpMatch)
  {
    let filePath = mpMatch[1].substring(1);
    return getFilename(filePath);
  }

  let absMatch = g_absolute_include_pattern.exec(text);
  g_absolute_include_pattern.lastIndex = 0;
  if (absMatch)
  {
    let filePath = absMatch[1].substring(1);
    return getFilename(filePath);
  }

  let relMatch = g_relative_include_pattern.exec(text);
  g_relative_include_pattern.lastIndex = 0;
  if (relMatch)
  {
    return getFilename(relMatch[1]);
  }

  return null;
}

function getPathFromInclude(text: string, root_path: string)
{
  return getPath(getFullPathFromInclude(text, root_path));
}

function getFullPathFromInclude(text: string, root_path: string)
{
  if (!text)
    return null;

  let mpMatch = g_mount_point_include_pattern.exec(text);
  g_mount_point_include_pattern.lastIndex = 0;
  if (mpMatch)
  {
    let conf = vscode.workspace.getConfiguration("blktool");
    let mountPoints = conf.get<{ [key: string]: string }>('mountPoints');

    if (!mountPoints) {
      return null;
    }

    let pathParts = mpMatch[1].replace(/\\/g, '/').split('/');
    let mpName = pathParts[0];
    let mpPath = mountPoints['%' + mpName];
    if (!mpPath) {
      return null;
    }

    return path.normalize(path.join(mpPath, pathParts.slice(1).join('/')));
  }

  let absMatch = g_absolute_include_pattern.exec(text);
  g_absolute_include_pattern.lastIndex = 0;
  if (absMatch)
  {
    let conf = vscode.workspace.getConfiguration("blktool");
    return path.normalize(path.join(conf.get('root'), absMatch[1]));
  }

  let relMatch = g_relative_include_pattern.exec(text);
  g_relative_include_pattern.lastIndex = 0;
  if (relMatch)
  {
    return path.normalize(path.join(root_path, relMatch[1]));
  }

  let strMatch = g_include_in_string_pattern.exec(text);
  g_include_in_string_pattern.lastIndex = 0;
  if (strMatch)
  {
    let conf = vscode.workspace.getConfiguration("blktool");

    let rootPath = path.normalize(path.join(conf.get('root'), 'develop', 'gameBase', strMatch[1]))
    logLine(`Checking: ${rootPath}`);

    if (fs.existsSync(rootPath))
    {
      return rootPath;
    }

    let searchDirs: Array<string> = conf.get('searchDirs');
    for (let dir of searchDirs)
    {
      let fullPath = path.normalize(path.join(dir, strMatch[1]));
      logLine(`Checking: ${fullPath}`);

      if (fs.existsSync(fullPath))
      {
        return fullPath;
      }
    }
  }

  return null;
}

function findIncludeInFiles(filename: string, root_path: string)
{
  if (g_search_in_progress)
  {
    logLine('Searching already in progress. Trying to stop...');

    g_should_stop_search = true;
    let pollId = setInterval(() =>
    {
      if (!g_search_in_progress)
      {
        clearInterval(pollId);
        findIncludeInFiles(filename, root_path);
      }
      else
      {
        logLine('Waiting for stop searching...');
      }
    }, 100);
    return;
  }

  let roots = ['<root>'];
  let conf = vscode.workspace.getConfiguration("blktool");
  let gameBasePath = path.join(conf.get('root'), 'develop', 'gameBase');

  let relPath = path.relative(root_path, gameBasePath);

  let basepath = root_path.replace(gameBasePath, '');
  if (basepath[0] == '\\')
    basepath = basepath.substring(1);

  let pathParts = basepath.split('\\');
  let filePath = '';
  let shouldAddToRoots = false;
  for (let part of pathParts)
  {
    if (part === '' || part[0] === '.')
      continue;
    if (part.indexOf(':') >= 0)
      part = part.toUpperCase();

    filePath += part + '\\';
    if (!shouldAddToRoots && part === 'gameBase')
      shouldAddToRoots = true;

    let p = filePath.replace(gameBasePath + path.sep, '');
    if (shouldAddToRoots && p.length > 0)
      roots.push(p);
  }

  vscode.window.showQuickPick(roots, { ignoreFocusOut: false, placeHolder: 'Select root folder for search' }).then(search_root =>
  {
    logLine('Searching all includes of "' + filename + '" in ' + search_root);

    if (search_root === '<root>')
      search_root = '/';

    vscode.workspace.findFiles('**' + search_root + '*.blk', '').then(files =>
    {
      logLine('Searching in ' + (files ? files.length : 0) + ' blk files...');

      let processOneFile = file =>
      {
        if (!file)
          return;

        if (g_should_stop_search)
        {
          g_search_in_progress = false;
          g_should_stop_search = false;
          vscode.window.setStatusBarMessage('Stopped!', 5000);
          logLine('Stopped!');
          return;
        }

        vscode.workspace.openTextDocument(file).then(document =>
        {
          if (hasInclude(document, filename))
            logLine('Found: ' + document.fileName);

          vscode.window.setStatusBarMessage('BLK files left: ' + files.length, 10000);
          file = files.pop();
          if (file)
            setTimeout(() => processOneFile(file), 10);
          else
          {
            g_search_in_progress = false;

            vscode.window.setStatusBarMessage('Done!', 5000);
            logLine('Done!');
          }
        }, reason =>
          {
            logLine(reason.message);
            vscode.window.setStatusBarMessage('Error!', 5000);
          });
      };

      if (files && files.length)
      {
        g_search_in_progress = true;
        processOneFile(files.pop());
      }
    });
  });
}

let diagnosticCollection: vscode.DiagnosticCollection = null;

function parseBLKErrors(document: vscode.TextDocument, data: string)
{
  var errors = []
  var errorsByLine = {}

  let pushError = function (message: string, lineNum: number)
  {
    if (errorsByLine[lineNum])
      return;

    errorsByLine[lineNum] = true;

    let diagnostic : vscode.Diagnostic = {
      severity: vscode.DiagnosticSeverity.Error,
      range: new vscode.Range(lineNum, 0, lineNum, document.lineAt(lineNum).text.length),
      message: message,
      source: 'blk',
      code: 0
    }
    errors.push(diagnostic);
  };

  data.split('\n').forEach(line => {
    if (line.startsWith('ERR:'))
    {
      // BLK error '%s',%d: %s
      let match = line.match(/ERR: BLK error '(?:.*)',(\d+): (.*)/);
      if (match)
        pushError(match[2], parseInt(match[1]) - 1);

      // BLK invalid %s (type %s) value in line %d of '%s': '%s'
      match = line.match(/ERR: BLK invalid (?:.*) \(type (?:.*)\) value in line (\d+) of '(?:.*)': '(?:.*)'/);
      if (match)
        pushError(match[0].substring('ERR: '.length), parseInt(match[1]) - 1);
    }
  });

  return errors;
}

function validateBlk(document: vscode.TextDocument)
{
  if (!diagnosticCollection)
    return;

  let filename = getFilename(document.fileName);

  if (!filename)
    return;

  let conf = vscode.workspace.getConfiguration("blktool");
  let mountPoints = conf.get<{ [key: string]: string }>('mountPoints');
  let extDir = vscode.extensions.getExtension("eguskov.blktool").extensionPath;
  let fileDir = path.dirname(document.fileName);
  var mountPointsCmd = [];
  for (let key in mountPoints)
  {
    mountPointsCmd.push('-mount:' + key.replace('%', '') + '=' + mountPoints[key]);
  }
  
  child_process.execFile(path.join(extDir, 'binBlk.exe'), [path.basename(document.fileName), '-', '-t', '-h', '-v', '-root:' + conf.get('root'), '-final'].concat(mountPointsCmd), { cwd: fileDir }, function (err, data)
  {
    if (err)
    {
      diagnosticCollection.set(document.uri, parseBLKErrors(document, data));

      vscode.commands.executeCommand('workbench.action.problems.focus');
    }
  });
}

export function activate(context: vscode.ExtensionContext)
{
  let out = vscode.window.createOutputChannel("BLKTool");
  out.show();
  g_out = out;

  logLine('Welcome to BLK Tool');

  diagnosticCollection = vscode.languages.createDiagnosticCollection('blk');
  context.subscriptions.push(diagnosticCollection);

  blk.setDiagnosticCollection(diagnosticCollection);

  vscode.languages.setLanguageConfiguration('blk', {
    wordPattern: /("(?:[^\\\"]*(?:\\.)?)*"?)|[^\s{}\[\],:]+/,
    indentationRules: {
      increaseIndentPattern: /^.*(\{[^}]*|\[[^\]]*)$/,
      decreaseIndentPattern: /^\s*[}\]],?\s*$/
    }
  });

  context.subscriptions.push(vscode.workspace.onDidSaveTextDocument(document => {
    if (document.languageId === 'blk')
    {
      validateBlk(document);
    }
  }));

  context.subscriptions.push(vscode.workspace.onDidOpenTextDocument(document => {
    if (document.languageId === 'blk')
    {
      validateBlk(document);
    }
  }));

  context.subscriptions.push(vscode.languages.registerDocumentRangeFormattingEditProvider('blk', new blk.RangeFormattingEditProvider));

  context.subscriptions.push(vscode.commands.registerCommand('extension.blktool.openInclude', () =>
  {
    let editor = vscode.window.activeTextEditor;
    if (!editor)
      return;

    let document = editor.document;
    if (!document || !document.fileName.endsWith('.blk'))
      return;

    let text = document.lineAt(editor.selection.start).text;
    let filePath = getFullPathFromInclude(text, getPath(document.uri));
    if (filePath)
      vscode.workspace.openTextDocument(filePath).then(value => vscode.window.showTextDocument(value, vscode.ViewColumn.Two, false), onFileOpenError);
    else
      vscode.window.showErrorMessage('Include not found');
  }));

  context.subscriptions.push(vscode.commands.registerCommand('extension.blktool.showResultFile', () =>
  {
    let editor = vscode.window.activeTextEditor;
    if (!editor)
      return;

    let document = editor.document;
    if (!document || !document.fileName.endsWith('.blk'))
      return;

    let filename = getFilename(document.fileName);

    if (filename)
    {
      let conf = vscode.workspace.getConfiguration("blktool");
      let mountPoints = conf.get<{ [key: string]: string }>('mountPoints');
      let extDir = vscode.extensions.getExtension("eguskov.blktool").extensionPath;
      let fileDir = path.dirname(document.fileName);
      var mountPointsCmd = [];
      for (let key in mountPoints)
      {
        mountPointsCmd.push('-mount:' + key.replace('%', '') + '=' + mountPoints[key]);
      }

      diagnosticCollection.clear();
      
      child_process.execFile(path.join(extDir, 'binBlk.exe'), [path.basename(document.fileName), '-', '-t', '-root:' + conf.get('root'), '-final'].concat(mountPointsCmd), { cwd: fileDir }, function (err, data)
      {
        if (err)
        {
          vscode.window.showErrorMessage(data);

          diagnosticCollection.set(document.uri, parseBLKErrors(document, data));

          vscode.commands.executeCommand('workbench.action.problems.focus');
        }

        vscode.workspace.openTextDocument(document.uri.with({ scheme: 'untitled', path: path.join(getPath(document.uri), `[final: ${filename}]`) }))
          .then(value =>
          {
            vscode.window.showTextDocument(value, vscode.ViewColumn.Two, false).then(editor => editor.edit(builder => builder.insert(editor.selection.start, data)))
          }, onFileOpenError);
      });
    }
    else
      vscode.window.showErrorMessage('Include not found');

  }));

  context.subscriptions.push(vscode.commands.registerCommand('extension.blktool.findSelfInclude', () =>
  {

    let editor = vscode.window.activeTextEditor;
    if (!editor)
      return;

    let document = editor.document;
    if (!document || !document.fileName.endsWith('.blk'))
      return;

    let filename = getFilename(document.fileName);

    if (filename)
      findIncludeInFiles(filename, getPath(document.uri));
    else
      vscode.window.showErrorMessage('Include not found');

  }));

  context.subscriptions.push(vscode.commands.registerCommand('extension.blktool.findInclude', () =>
  {

    let editor = vscode.window.activeTextEditor;
    if (!editor)
      return;

    let document = editor.document;
    if (!document || !document.fileName.endsWith('.blk'))
      return;

    let text = document.lineAt(editor.selection.start).text;
    let filename = getFilenameFromInclude(text);

    if (filename)
      findIncludeInFiles(filename, getPathFromInclude(text, getPath(document.uri)));
    else
      vscode.window.showErrorMessage('Include not found');
  }));

  context.subscriptions.push(vscode.commands.registerCommand('extension.blktool.findAllIncludes', () =>
  {

    let editor = vscode.window.activeTextEditor;
    if (!editor)
      return;

    let document = editor.document;
    if (!document || !document.fileName.endsWith('.blk'))
      return;

    let absoluteIncludePattern = new RegExp("(?:\\binclude\\b)(?:\\s+)[\"']#(.*)[\"']", 'gi');
    let relativeIncludePattern = new RegExp("(?:\\binclude\\b)(?:\\s+)[\"']([^#].*)[\"']", 'gi');

    for (let lineNo = 0; lineNo < document.lineCount; ++lineNo)
    {
      let line = document.lineAt(lineNo).text;
      let absMatch = absoluteIncludePattern.exec(line);
      let relMatch = relativeIncludePattern.exec(line);

      if (relMatch)
      {
        let filePath = relMatch[1];

        console.log('Line ' + (lineNo + 1) + ':' + relMatch[1]);
      }

      if (absMatch)
      {
        let filePath = absMatch[1];

        console.log('Line ' + (lineNo + 1) + ':' + absMatch[1]);

        // if (lineNo == 7)
        //   vscode.workspace.openTextDocument('D:/dagor2/skyquake/' + filePath.substring(1)).then(value => {

        //     console.log(value);

        //   });
      }
    }

  }));

}

export function deactivate()
{
  if (g_search_in_progress)
  {
    logLine('Trying to stop searching...');
    g_should_stop_search = true;
    return;
  }
}