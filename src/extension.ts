'use strict';
import * as vscode from 'vscode';
import * as path from 'path';
import * as child_process from 'child_process';

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
  let pos = filePath.lastIndexOf('/');
  if (pos < 0)
    pos = filePath.lastIndexOf('\\');
  return filePath.substring(pos + 1);
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

  let absMatch = g_absolute_include_pattern.exec(text);
  g_absolute_include_pattern.lastIndex = 0;
  if (absMatch)
  {
    let filePath = absMatch[1].substring(1);
    return path.normalize(vscode.workspace.rootPath + '/../../' + filePath);
  }

  let relMatch = g_relative_include_pattern.exec(text);
  g_relative_include_pattern.lastIndex = 0;
  if (relMatch)
  {
    return path.normalize(root_path + '/' + relMatch[1]);
  }

  let strMatch = g_include_in_string_pattern.exec(text);
  g_include_in_string_pattern.lastIndex = 0;
  if (strMatch)
  {
    return path.normalize(vscode.workspace.rootPath + '/' + strMatch[1]);
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

  let basepath = root_path.replace(vscode.workspace.rootPath, '');
  if (basepath[0] == '\\')
    basepath = basepath.substring(1);

  let pathParts = basepath.split('\\');
  let filePath = '';
  for (let part of pathParts)
  {
    if (part === '' || part[0] === '.')
      continue;
    filePath += part + '\\';
    roots.push(filePath);
  }

  vscode.window.showQuickPick(roots, { ignoreFocusOut: false, placeHolder: 'Select root folder for search' }).then(search_root =>
  {
    logLine('Searching all includes of "' + filename + '" in ' + search_root);

    if (search_root === '<root>')
      search_root = '/';

    vscode.workspace.findFiles('**' + search_root + '*.blk', '').then(files =>
    {
      logLine('Searching in ' + files.length + ' blk files...');

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

      if (files.length)
      {
        g_search_in_progress = true;
        processOneFile(files.pop());
      }
    });
  });
}

const enum BLKTokenType
{
  Block,
  BlockEnd,
  Param,
  Include,
  Comment
}

class BLKToken
{
  constructor(public indent: string, public value: string, public offset: number, public type: BLKTokenType)
  {
  }
}

class BLKBlockToken extends BLKToken
{
  singleLine: boolean = false;
  empty: boolean = false;

  constructor(indent: string, name: string, public ws: string, offset: number)
  {
    super(indent, name, offset, BLKTokenType.Block);
  }
}

class BLKBlockEndToken extends BLKToken
{
  constructor(indent: string, offset: number)
  {
    super(indent, '', offset, BLKTokenType.BlockEnd);
  }
}

class BLKParamToken extends BLKToken
{
  constructor(indent: string, name: string, public paramType: string, public equals: string, public paramValue: string, offset: number)
  {
    super(indent, name, offset, BLKTokenType.Param);
  }
}

class BLKIncludeToken extends BLKToken
{
  constructor(indent: string, path: string, offset: number)
  {
    super(indent, path, offset, BLKTokenType.Include);
  }
}

class BLKCommentToken extends BLKToken
{
  constructor(indent: string, value: string, offset: number)
  {
    super(indent, value, offset, BLKTokenType.Comment);
  }
}

class BLKScanner
{
  private _offset = 0;

  constructor(private _data: string)
  {

  }

  getBlock(): BLKBlockToken
  {
    let re = /^(\s*)([\w_@\-": ]+)(\s*)\{/mg;
    let match = re.exec(this._data);

    if (match)
    {
      let start = re.lastIndex - match[0].length;
      if (start != 0)
        return null;

      let [text, indent, name, ws] = match;
      {
        let re = / +$/g;
        let match = re.exec(name);
        if (match && match[0].length)
        {
          name = name.replace(match[0], '');
          ws += match[0];
        }
      }
      let token = new BLKBlockToken(indent, name, ws, this._offset);

      {
        let re = /^(?:\s*)(?:[\w_@\-": ]+)(?:\s*)\{(?:[^\n\r]*?)\}/g;
        let match = re.exec(this._data);
        token.singleLine = match && re.lastIndex == match[0].length;
      }

      {
        let re = /^(?:\s*)(?:[\w_@\-": ]+)(?:\s*)\{(?:\s*?)\}/g;
        let match = re.exec(this._data);
        token.empty = match && re.lastIndex == match[0].length;
      }

      let offset = match[0].length;
      this._offset += offset;
      this._data = this._data.substring(offset);

      return token;
    }

    return null;
  }

  getBlockEnd(): BLKBlockEndToken
  {
    let re = /^(\s*)\}/g;
    let match = re.exec(this._data);

    if (match)
    {
      let start = re.lastIndex - match[0].length;
      if (start != 0)
        return null;

      let [text, indent] = match;
      let token = new BLKBlockEndToken(indent, this._offset);

      let offset = match[0].length;
      this._offset += offset;
      this._data = this._data.substring(offset);

      return token;
    }

    return null;
  }

  getParam(): BLKParamToken
  {
    let re = /^(\s*)([\w_@\-": ]+):([\w ]+)(\s*=\s*)([^;\r\n\t]+);{0,1}/g;
    let match = re.exec(this._data);

    if (match)
    {
      let start = re.lastIndex - match[0].length;
      if (start != 0)
        return null;

      let [text, indent, name, type, equals, value] = match;
      let token = new BLKParamToken(indent, name, type, equals, value, this._offset);

      let offset = match[0].length;
      this._offset += offset;
      this._data = this._data.substring(offset);

      return token;
    }

    return null;
  }

  getInclude(): BLKIncludeToken
  {
    let re = /^(\s*)include(?:\s*)["']([^'"]+)["']/g;
    let match = re.exec(this._data);

    if (match)
    {
      let start = re.lastIndex - match[0].length;
      if (start != 0)
        return null;

      let [text, indent, path] = match;
      let token = new BLKIncludeToken(indent, path, this._offset);

      let offset = match[0].length;
      this._offset += offset;
      this._data = this._data.substring(offset);

      return token;
    }

    return null;
  }

  getComment(): BLKCommentToken
  {
    let re = /^(\s*)\/\/([^\r\n]*)/g;
    let match = re.exec(this._data);

    if (!match)
    {
      re = /^(?:\s*)\/\*([^\*]*)\*\//gm;
      match = re.exec(this._data);
      // console.log(match);
    }

    if (match)
    {
      let start = re.lastIndex - match[0].length;
      if (start != 0)
        return null;

      let [text, indent, value] = match;
      let token = new BLKCommentToken(indent, value, this._offset);

      let offset = match[0].length;
      this._offset += offset;
      this._data = this._data.substring(offset);

      return token;
    }

    return null;
  }

  nextToken(): BLKToken
  {
    let token: BLKToken = this.getBlock();

    if (!token)
      token = this.getBlockEnd();
    if (!token)
      token = this.getParam();
    if (!token)
      token = this.getInclude();
    if (!token)
      token = this.getComment();

    return token;
  }
}

class BLKFormattingProvider implements vscode.DocumentRangeFormattingEditProvider
{
  provideDocumentRangeFormattingEdits(document: vscode.TextDocument, range: vscode.Range, options: vscode.FormattingOptions, token: vscode.CancellationToken): vscode.TextEdit[] | Thenable<vscode.TextEdit[]>
  {
    logLine('provideDocumentRangeFormattingEdits');
    logLine(range.start.line + ' ' + range.end.line);

    let _range = (from: vscode.Position, to: vscode.Position) => new vscode.Range(from, to);
    let _replace = (r: vscode.Range, t: string) => vscode.TextEdit.replace(r, t);

    let edits: vscode.TextEdit[] = [];

    let fullText = document.getText(range);
    let scanner = new BLKScanner(fullText);

    let level = 0;
    let curToken = scanner.nextToken();
    let blockTokens: BLKBlockToken[] = [];
    let isFirstToken = true;
    while (curToken)
    {
      // console.log(curToken);
      if (curToken.type == BLKTokenType.Block)
      {
        let block = <BLKBlockToken>curToken;
        blockTokens.push(block);

        if (block.ws != ' ')
        {
          let from = document.positionAt(block.offset + block.indent.length + block.value.length);
          let to = document.positionAt(block.offset + block.indent.length + block.value.length + block.ws.length);

          edits.push(_replace(_range(from, to), ' '));
        }

        let indent = '  '.repeat(level);
        //if (/* block.indent != indent */indent != '')
        if (!isFirstToken)
        {
          let from = document.positionAt(block.offset);
          let to = document.positionAt(block.offset + block.indent.length);
          edits.push(_replace(_range(from, to), "\n" + indent));
        }

        ++level;
      }
      else if (curToken.type == BLKTokenType.BlockEnd)
      {
        let openBlock = blockTokens[blockTokens.length - 1];

        --level;
        blockTokens.pop();

        let block = <BLKBlockEndToken>curToken;
        let indent = '  '.repeat(level);
        if (block.indent != indent)
        {
          let empty = openBlock && openBlock.empty;
          let singleLine = openBlock && openBlock.singleLine;
          if (empty)
            indent = '';
          else if (singleLine)
            indent = ' ';

          let from = document.positionAt(block.offset);
          let to = document.positionAt(block.offset + block.indent.length);
          edits.push(_replace(_range(from, to), (singleLine || empty ? "" : "\n") + indent));
        }
      }
      else if (curToken.type == BLKTokenType.Param)
      {
        let param = <BLKParamToken>curToken;
        let indent = '  '.repeat(level);
        // if (/* param.indent != indent  */indent != '')
        if (!isFirstToken)
        {
          let block = blockTokens[blockTokens.length - 1];

          let singleLine = block && block.singleLine;
          if (singleLine)
            indent = ' ';

          let from = document.positionAt(param.offset);
          let to = document.positionAt(param.offset + param.indent.length);
          edits.push(_replace(_range(from, to), (singleLine ? "" : "\n") + indent));
        }
        if (param.equals != ' = ')
        {
          let from = document.positionAt(param.offset + param.indent.length + param.value.length + 1 + param.paramType.length);
          let to = document.positionAt(param.offset + param.indent.length + param.value.length + 1 + param.paramType.length + param.equals.length);
          edits.push(_replace(_range(from, to), ' = '));
        }
        let re = /(?:^ +)|(?: +$)/g;
        let match = re.exec(param.paramType);
        if (match)
        {
          let from = document.positionAt(param.offset + param.indent.length + param.value.length + 1);
          let to = document.positionAt(param.offset + param.indent.length + param.value.length + 1 + param.paramType.length);
          edits.push(_replace(_range(from, to), param.paramType.replace(/ /g, '')));
        }
      }
      else if (curToken.type == BLKTokenType.Include)
      {
        let include = <BLKIncludeToken>curToken;
        let indent = '  '.repeat(level);
        //if (indent != '')
        if (!isFirstToken)
        {
          let from = document.positionAt(include.offset);
          let to = document.positionAt(include.offset + include.indent.length);
          edits.push(_replace(_range(from, to), "\n" + indent));
        }
      }

      curToken = scanner.nextToken();
      isFirstToken = false;
    }

    // console.log(scanner);

    // fullText = fullText.replace(/\{[\s\n\r]*\}/gm, "{}");
    // fullText = fullText.replace(/(\w+)(?:[\s\n\r]*)\{/gm, "$1 {");
    // edits.push(vscode.TextEdit.replace(range, fullText));

    // for (let lineNo = 0; lineNo < 10; ++lineNo)
    // {
    //   let line = document.lineAt(lineNo);
    //   let re = /\s*=\s*/g;

    //   if (line.text.match(re))
    //   {
    //     let text = line.text.replace(re, ' = ');
    //     edits.push(vscode.TextEdit.replace(line.range, text));
    //   }
    // }

    // let level = 0;
    // let offset = 0;
    //let lineStart = 0;
    // for (let i = 0; i < fullText.length; ++i, ++offset)
    // {
    //   let ch = fullText.charAt(i);
    //   if (ch == " " || ch == "\n" || ch == "\t" || ch == "\r")
    //   {
    //     continue;
    //   }

    //   console.log(i, ch);

    //   if (ch == '{')
    //   {
    //     ++level;
    //     console.log('LEVEL = ' + level);

    //     let pos = document.positionAt(i + 1);
    //     let line = document.lineAt(pos);

    //     let editPos = pos;
    //     let editText = '';
    //     if (!pos.isEqual(line.range.end))
    //     {
    //       let lineEndingRange = new vscode.Range(pos, line.range.end);
    //       let lineEnding = document.getText(lineEndingRange);
    //       if (lineEnding.match(/^\s+$/))
    //         edits.push(vscode.TextEdit.replace(lineEndingRange, ''));
    //       else
    //       {
    //         editText += "\n";
    //         editText += ' '.repeat(2 * level);
    //         editText += lineEnding.replace(/^\s+/, '');
    //         // edits.push(vscode.TextEdit.insert(pos, "\n"));
    //         edits.push(vscode.TextEdit.replace(lineEndingRange, editText));
    //       }
    //     }
    //   }
    //   else if (ch == '}')
    //   {
    //     --level;
    //     console.log('LEVEL = ' + level);
    //   }
    //   else if (level > 0)
    //   {
    //     let pos = document.positionAt(i);
    //     let line = document.lineAt(pos);

    //     let openPos = line.text.indexOf('{');
    //     let closePos = line.text.indexOf('}');

    //     console.log(line.text.substring(lineStart));

    //     let len = 0;
    //     let re = /^(\s+)/;
    //     let match = re.exec(line.text);
    //     if (match)
    //     {
    //       len = match[1].length;
    //     }

    //     let indent = ' '.repeat(2 * level);
    //     if (len != indent.length)
    //     {
    //       console.log('Reindent');

    //       let startIndent = line.range.start;
    //       if (openPos >= 0 && closePos < 0)
    //       {
    //         startIndent = document.positionAt(openPos);
    //         indent = "\n" + indent;
    //       }
    //       else if (openPos >= 0 && closePos >= 0)
    //       {
    //       }

    //       let indentRange = new vscode.Range(startIndent, pos);
    //       //edits.push(vscode.TextEdit.replace(indentRange, indent));
    //     }
    //     else if (len == 0)
    //     {
    //       console.log('Insert indent');

    //       //edits.push(vscode.TextEdit.insert(document.positionAt(i - 1), indent));
    //     }

    //     let p = openPos;
    //     if (p < 0)
    //       p = closePos;
    //     if (p < 0)
    //       p = line.text.length;
    //     i += p - 1;
    //   }
    // }

    // edits = [];

    return edits;
  }
}

export function activate(context: vscode.ExtensionContext)
{

  let out = vscode.window.createOutputChannel("BLKTool");
  out.show();
  g_out = out;

  logLine('Welcome to BLK Tool');

  vscode.languages.setLanguageConfiguration('blk', {
    wordPattern: /("(?:[^\\\"]*(?:\\.)?)*"?)|[^\s{}\[\],:]+/,
    indentationRules: {
      increaseIndentPattern: /^.*(\{[^}]*|\[[^\]]*)$/,
      decreaseIndentPattern: /^\s*[}\]],?\s*$/
    }
  });

  context.subscriptions.push(vscode.languages.registerDocumentRangeFormattingEditProvider('blk', new BLKFormattingProvider));

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
      let extDir = vscode.extensions.getExtension("eguskov.blktool").extensionPath;
      child_process.execFile('blk.exe', ['-blk:' + document.fileName, '-root:' + conf.get('root')], { cwd: extDir }, function (err, data)
      {
        data = data.replace(/^[\r\n]/gm, '');
        vscode.workspace.openTextDocument(document.uri.with({ scheme: 'untitled', path: path.join(getPath(document.uri), filename + '-parsed.blk') }))
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