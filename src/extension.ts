'use strict';
import * as vscode from 'vscode';
import * as path from 'path';
import * as child_process from 'child_process';
import * as fs from 'fs';

import { blk } from './blk-pegjs';

const g_mount_point_include_pattern = new RegExp("(?:\\binclude\\b)(?:\\s+)[\"']%(.*)[\"']", 'gi');
const g_absolute_include_pattern = new RegExp("(?:\\binclude\\b)(?:\\s+)[\"']#(.*)[\"']", 'gi');
const g_relative_include_pattern = new RegExp("(?:\\binclude\\b)(?:\\s+)[\"']([^#].*)[\"']", 'gi');
const g_include_in_string_pattern = new RegExp("[\"'](.*\.blk)[\"']", 'gi');

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
    else
    {
      diagnosticCollection.clear();
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
    if (!document || document.languageId !== 'blk')
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

    document.save().then(() =>
    {
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
          else
          {
            vscode.workspace.openTextDocument({language: 'blk'}).then(value => {
              vscode.window.showTextDocument(value, vscode.ViewColumn.Two, false).then(editor => editor.edit(builder => builder.insert(editor.selection.start, data)))
            });
          }
        });
      }
      else
        vscode.window.showErrorMessage('Include not found');
    });

  }));
}

export function deactivate()
{
}