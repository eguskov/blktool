'use strict';
import * as vscode from 'vscode';

export namespace blk
{
  const enum TokenType
  {
    Block,
    BlockEnd,
    Param,
    Include,
    Comment
  }

  interface IMatcher
  {
    re: RegExp;
    process: ((scanner: Scanner, match: RegExpExecArray) => Token | Error);
  }

  let tokenMatchers: IMatcher[] = [];

  declare type Matcher = <Function>(target: Function) => Function | void;

  function Matcher(target: any)
  {
    if (Array.isArray(target.matcher))
      tokenMatchers = tokenMatchers.concat(target.matcher);
    else
      tokenMatchers.push(target.matcher);
    return target;
  }

  class Error
  {
    constructor(public msg: string, public offset: number)
    {
    }
  }

  class Token
  {
    public offset: number = -1;

    constructor(public indent: string, public type: TokenType)
    {
    }
  }

  @Matcher
  class BlockToken extends Token
  {
    static matcher =
    {
      re: /^(\s*)([\w_@\-": \[\]]+)(\s*)\{/mg,
      process: (scanner: Scanner, match: RegExpExecArray) =>
      {
        let [text, indent, name, ws] = match;

        let wsFromName = '';
        [name, wsFromName] = scanner.trimTailWS(name);
        ws += wsFromName;

        let token = new BlockToken(indent, name, ws);

        token.singleLine = scanner.isDataMatch(/^(?:\s*)(?:[\w_@\-": \[\]]+)(?:\s*)\{(?:[^\n\r]*?)\}/g);
        token.empty = scanner.isDataMatch(/^(?:\s*)(?:[\w_@\-": \[\]]+)(?:\s*)\{(?:\s*?)\}/g);

        return token;
      }
    }

    singleLine: boolean = false;
    empty: boolean = false;

    constructor(indent: string, public name: string, public ws: string)
    {
      super(indent, TokenType.Block);
    }

    get wsOffset() { return this.offset + this.indent.length + this.name.length; }
  }

  @Matcher
  class BlockEndToken extends Token
  {
    static matcher =
    {
      re: /^(\s*)\}/g,
      process: (scanner: Scanner, match: RegExpExecArray) => new BlockEndToken(match[1])
    }

    constructor(indent: string)
    {
      super(indent, TokenType.BlockEnd);
    }
  }

  @Matcher
  class ParamToken extends Token
  {
    static paramValueCheckers =
    {
      't': /[\'\"](?:.*?)[\'\"]/,
      'i': /[\-\d]+/,
      'i64': /[\-\d]+/,
      'r': /[\-\d\.]+/,
      'p2': /[\-\d\.]+\,(?:\s*)[\-\d\.]+/,
      'p3': /[\-\d\.]+\,(?:\s*)[\-\d\.]+\,(?:\s*)[\-\d\.]+/,
      'p4': /[\-\d\.]+\,(?:\s*)[\-\d\.]+\,(?:\s*)[\-\d\.]+\,(?:\s*)[\-\d\.]+/,
      'ip2': /[\-\d]+\,(?:\s*)[\-\d]+/,
      'ip3': /[\-\d]+\,(?:\s*)[\-\d]+\,(?:\s*)[\-\d]+/,
      'ip4': /[\-\d]+\,(?:\s*)[\-\d]+\,(?:\s*)[\-\d]+\,(?:\s*)[\-\d]+/,
      'b': /\btrue\b|\bfalse\b|\byes\b|\bno\b|\bon\b|\boff\b/,
      'c': /[\-\d]+\,(?:\s*)[\-\d]+\,(?:\s*)[\-\d]+(?:\,(?:\s*)[\-\d]+)?/,
      'm': /\[\[[\-\d\.]+\, [\-\d\.]+\, [\-\d\.]+\] \[[\-\d\.]+\, [\-\d\.]+\, [\-\d\.]+\] \[[\-\d\.]+\, [\-\d\.]+\, [\-\d\.]+\] \[[\-\d\.]+\, [\-\d\.]+\, [\-\d\.]+\]\]/
    }

    static matcher =
    {
      re: /^(\s*)([\w_@\-": \[\]]+):([\w ]+)(\s*=\s*)([^;\}\r\n\t]+);{0,1}/g,
      process: (scanner: Scanner, match: RegExpExecArray) =>
      {
        let paramType = match[3];
        let paramValue = match[5];

        let commentPos = paramValue.indexOf('/*');
        if (commentPos < 0)
          commentPos = paramValue.indexOf('//');

        if (commentPos >= 0)
        {
          {
            let commentPos = match[0].indexOf('/*');
            if (commentPos < 0)
              commentPos = match[0].indexOf('//');
            if (commentPos >= 0)
              match[0] = match[0].substring(0, commentPos);
          }
          match[5] = paramValue = paramValue.substring(0, commentPos);
        }

        let [paramValueWithoutWS, paramValueWS] = scanner.trimTailWS(paramValue);
        if (paramValueWS.length > 0)
        {
          match[5] = paramValue = paramValueWithoutWS;
          match[0] = match[0].substring(0, match[0].length - paramValueWS.length);
        }

        let t = scanner.trimWS(paramType);
        let p = scanner.trimWS(paramValue);

        let checker = ParamToken.paramValueCheckers[t];
        if (checker)
        {
          let m = checker.exec(p);
          if (!m || m[0].length != p.length)
            return new Error('Wrong value[' + t + '] = ' + p, match[1].length + match[2].length + paramType.length);
        }

        if (checker === undefined)
          return new Error('Unknown parameter type: ' + t, match[1].length + match[2].length);

        return new ParamToken(match[1], match[2], paramType, match[4], paramValue);
      }
    }

    constructor(indent: string, public name: string, public paramType: string, public equals: string, public paramValue: string)
    {
      super(indent, TokenType.Param);
    }

    get paramTypeOffset() { return this.offset + this.indent.length + this.name.length + 1; }
    get paramValueOffset() { return this.equalsOffset + this.equals.length; }
    get equalsOffset() { return this.paramTypeOffset + this.paramType.length; }
  }

  @Matcher
  class IncludeToken extends Token
  {
    static matcher =
    {
      re: /^(\s*)include(?:\s*)["']([^'"]+)["']/g,
      process: (scanner: Scanner, match: RegExpExecArray) => new IncludeToken(match[1], match[2])
    }

    constructor(indent: string, public path: string)
    {
      super(indent, TokenType.Include);
    }
  }

  @Matcher
  class CommentToken extends Token
  {
    static matcher =
    [
      {
        re: /^(\s*)\/\/([^\r\n]*)/g,
        process: (scanner: Scanner, match: RegExpExecArray) => new CommentToken(match[1], match[2])
      },
      {
        re: /^(\s*)\/\*([\s\S]*)\*\//gm,
        process: (scanner: Scanner, match: RegExpExecArray) => new CommentToken(match[1], match[2])
      }
    ]

    constructor(indent: string, public content: string)
    {
      super(indent, TokenType.Comment);
    }
  }

  export class Scanner
  {
    private _offset = 0;
    private _linesWithError = {};

    constructor(private _data: string)
    {
    }

    isDataMatch(re: RegExp)
    {
      return this.parseData(re) !== null;
    }

    parseData(re: RegExp)
    {
      let match = re.exec(this._data);
      return match && re.lastIndex == match[0].length ? match : null;
    }

    trimTailWS(str: string)
    {
      let re = / +$/g;
      let match = re.exec(str);
      if (match && match[0].length)
      {
        str = str.replace(match[0], '');
        return [str, match[0]];
      }
      return [str, ''];
    }

    trimWS(str: string)
    {
      return str.replace(/(?:^\s+)|(?:\s+$)/gm, '');
    }

    addOffset(offset: number)
    {
      this._offset += offset;
      this._data = this._data.substring(offset);
    }

    nextToken(document: vscode.TextDocument, errors: vscode.Diagnostic[]): Token
    {
      let hasTokenWithError = false;
      for (let m of tokenMatchers)
      {
        m.re.lastIndex = 0;

        let match = this.parseData(m.re);
        if (!match)
          continue;

        let token = m.process(this, match);
        if (!token)
          continue;

        if (token instanceof Error)
        {
          let line = document.positionAt(this._offset + 1 + (<Error>token).offset).line;
          if (!this._linesWithError[line])
          {
            this._linesWithError[line] = true;
            let range = document.lineAt(line).range;
            errors.push(new vscode.Diagnostic(range, (<Error>token).msg, vscode.DiagnosticSeverity.Error));
          }

          hasTokenWithError = true;
          this.addOffset(match[0].length);

          break;
        }

        (<Token>token).offset = this._offset;

        this.addOffset(match[0].length);

        return <Token>token;
      }

      if (hasTokenWithError)
        return this.nextToken(document, errors);

      let match = /^\s*$/gm.exec(this._data);
      if (match && match[0].length !== this._data.length)
      {
        let m = /^\s+/gm.exec(this._data);
        let wsOffset = m ? m[0].length : 0;
        let line = document.positionAt(this._offset + wsOffset).line;
        if (!this._linesWithError[line])
        {
          this._linesWithError[line] = true;
          let range = document.lineAt(line).range;
          errors.push(new vscode.Diagnostic(range, "Unknown token", vscode.DiagnosticSeverity.Error));
        }
      }

      if (this._offset < this._data.length)
      {
        ++this._offset;
        this._data = this._data.substring(1);
        return this.nextToken(document, errors);
      }

      return null;
    }
  }

  let g_diagnostic_collection: vscode.DiagnosticCollection = null;

  export function setDiagnosticCollection(diagnosticCollection: vscode.DiagnosticCollection)
  {
    g_diagnostic_collection = diagnosticCollection;
  }

  export class RangeFormattingEditProvider implements vscode.DocumentRangeFormattingEditProvider
  {
    edits: vscode.TextEdit[] = [];

    addEdit(document: vscode.TextDocument, from: number, length: number, replaceWith: string)
    {
      let range = new vscode.Range(document.positionAt(from), document.positionAt(from + length));
      if (document.validateRange(range))
        this.edits.push(vscode.TextEdit.replace(range, replaceWith));
    }

    provideDocumentRangeFormattingEdits(document: vscode.TextDocument, range: vscode.Range, options: vscode.FormattingOptions, token: vscode.CancellationToken): vscode.TextEdit[] | Thenable<vscode.TextEdit[]>
    {
      this.edits = [];

      let errors: vscode.Diagnostic[] = [];

      g_diagnostic_collection.clear();

      let fullText = document.getText(range);
      let scanner = new Scanner(fullText);

      let level = 0;
      let curToken = scanner.nextToken(document, errors);
      let blockTokens: BlockToken[] = [];
      let isFirstToken = true;
      while (curToken)
      {
        // console.log(curToken);

        let newLineCount = 0;
        for (let ch of curToken.indent)
          if (ch == "\n")
            ++newLineCount;

        newLineCount = Math.min(newLineCount, 3);

        if (curToken instanceof BlockToken)
        {
          let block = <BlockToken>curToken;
          blockTokens.push(block);

          if (block.ws != ' ')
            this.addEdit(document, block.wsOffset, block.ws.length, ' ');

          let indent = '  '.repeat(level);
          if (!isFirstToken)
          {
            let newIndent = "\n".repeat(newLineCount) + indent;
            if (newIndent !== block.indent)
              this.addEdit(document, block.offset, block.indent.length, newIndent);
          }

          ++level;
        }
        else if (curToken instanceof BlockEndToken)
        {
          let openBlock = blockTokens[blockTokens.length - 1];
          if (openBlock && level > 0)
          {
            --level;
            blockTokens.pop();

            let block = <BlockEndToken>curToken;
            let indent = '  '.repeat(level);
            if (!isFirstToken)
            {
              let empty = openBlock && openBlock.empty;
              let singleLine = openBlock && openBlock.singleLine;
              if (empty)
                indent = '';
              else if (singleLine)
                indent = ' ';

              this.addEdit(document, block.offset, block.indent.length, (singleLine || empty ? "" : "\n") + indent);
            }
          }
          else
          {
            let range = document.lineAt(document.positionAt(curToken.offset).line).range;
            errors.push(new vscode.Diagnostic(range, "Missed {", vscode.DiagnosticSeverity.Error));
          }
        }
        else if (curToken instanceof ParamToken)
        {
          let param = <ParamToken>curToken;
          let indent = '  '.repeat(level);
          if (!isFirstToken)
          {
            let block = blockTokens[blockTokens.length - 1];

            let singleLine = block && block.singleLine;
            if (singleLine)
              indent = ' ';

            let newIndent = (singleLine ? "" : "\n".repeat(newLineCount)) + indent;
            if (newIndent !== param.indent)
              this.addEdit(document, param.offset, param.indent.length, newIndent);

            // let m = /\s+$/.exec(param.paramValue);
            // if (m && m[0].length > 0)
            // {
            //   this.addEdit(document, param.paramValueOffset + param.paramValue.length - m[0].length, m[0].length, '');
            // }
          }

          if (param.equals != ' = ')
            this.addEdit(document, param.equalsOffset, param.equals.length, ' = ');

          let re = /(?:^ +)|(?: +$)/g;
          let match = re.exec(param.paramType);
          if (match)
            this.addEdit(document, param.paramTypeOffset, param.paramType.length, param.paramType.replace(/ /g, ''));
        }
        else if (curToken instanceof IncludeToken)
        {
          let include = <IncludeToken>curToken;
          let indent = '  '.repeat(level);
          if (!isFirstToken)
            this.addEdit(document, include.offset, include.indent.length, "\n".repeat(newLineCount) + indent);
        }
        else if (curToken instanceof CommentToken)
        {
          // let indent = '  '.repeat(level);
          // if (!isFirstToken)
          //   this.addEdit(document, curToken.offset, curToken.indent.length, "\n".repeat(newLineCount) + indent);
        }

        curToken = scanner.nextToken(document, errors);
        isFirstToken = false;
      }

      if (level !== 0)
      {
        let range = document.lineAt(document.lineCount - 1).range;
        errors.push(new vscode.Diagnostic(range, "Missed }", vscode.DiagnosticSeverity.Error));
      }

      // console.log(scanner);

      g_diagnostic_collection.set(document.uri, errors);

      return this.edits;
    }
  }
}