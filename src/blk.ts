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
    process: ((scanner: Scanner, match: RegExpExecArray) => Token);
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
    static matcher =
    {
      re: /^(\s*)([\w_@\-": \[\]]+):([\w ]+)(\s*=\s*)([^;\r\n\t]+);{0,1}/g,
      process: (scanner: Scanner, match: RegExpExecArray) => new ParamToken(match[1], match[2], match[3], match[4], match[5])
    }

    constructor(indent: string, public name: string, public paramType: string, public equals: string, public paramValue: string)
    {
      super(indent, TokenType.Param);
    }

    get paramTypeOffset() { return this.offset + this.indent.length + this.name.length + 1; }
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
        re: /^(?:\s*)\/\*([^\*]*)\*\//gm,
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

    nextToken(): Token
    {
      for (let m of tokenMatchers)
      {
        m.re.lastIndex = 0;

        let match = this.parseData(m.re);
        if (!match)
          continue;

        let token = m.process(this, match);
        if (!token)
          continue;

        token.offset = this._offset;

        this._offset += match[0].length;
        this._data = this._data.substring(match[0].length);

        return token;
      }

      if (this._offset < this._data.length)
      {
        ++this._offset;
        this._data = this._data.substring(1);
        return this.nextToken();
      }

      return null;
    }
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

      let fullText = document.getText(range);
      let scanner = new Scanner(fullText);

      let level = 0;
      let curToken = scanner.nextToken();
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
            this.addEdit(document, block.offset, block.indent.length, "\n".repeat(newLineCount) + indent);

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
            if (block.indent != indent)
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

            this.addEdit(document, param.offset, param.indent.length, (singleLine ? "" : "\n".repeat(newLineCount)) + indent);
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

        curToken = scanner.nextToken();
        isFirstToken = false;
      }

      // console.log(scanner);

      return this.edits;
    }
  }
}